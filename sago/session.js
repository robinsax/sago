/**
*   Database session and query machinery definitions. Database sessions are
*   accessed through their parent databases, and queries are created indirectly
*   through sessions. 
*/
const { 
    SchemaError, SessionStateError, ModelStateError 
} = require('./errors');
const { resolveOneHotAttributeReference } = require('./utils');

/**
*   Return a key to uniquely identify the given model in a session state. 
*/
const stateKeyForModelRow = (M, row) => {
    const {_schema: {collection, pkAttribute}} = M, pkValue = row[pkAttribute];
        
    return collection + '_' + pkValue;
}

/**
*   Return a key to uniquely identify the given model. 
*/
const stateKeyForModel = model => (
    stateKeyForModelRow(model.constructor, model)
);

/**
*   Compute a topological sort of the given set of ephemeral models by
*   their inter-relationships. This has the side-effect of including all models
*   that are not in the input set, but can be reached via relationships, in the
*   output set.
*
*   The return value is an array where each entry contains an object holding:
*   the model to create and a post-creation hook callable for that model. The
*   post-creation hook is used to assign foreign key values on all dependent
*   models.
*/
const orderEphemeralModelsByRelationshipIntent = models => {
    //  TODO: Cycle handling.

    //  Create output storage.
    const outputModelSet = [], outputHooks = {};

    //  Define the visit algorithm.
    /**
    *   DFS-visit the given model.
    */
    const visit = model => {
        //  Check state.
        if (model._dfsState == 2) return;
        if (model._dfsState == 1) throw new Error(
            'Cycle handling not implemented'
        );
        
        //  Update this models state as visit (in progress).
        model._dfsState = 1;
        //  Visit neighbors.
        if (model._bindIntents) {
            model._bindIntents.forEach(({target}) => {
                visit(target);
            });
        }
        //  Update this models state as visited (complete).
        model._dfsState = 2;

        //  Add the model to the output set.
        outputModelSet.push(model);
        //  If this model has bind intents associated with it, for each one,
        //  expand the hook set of the target it points to such that when the
        //  target is created the foreign key value on the current model will
        //  be assigned.
        if (model._bindIntents) {
            model._bindIntents.forEach(({
                target, sourceAttribute, destinationAttribute
            }) => {
                //  Retrieve a unique key for the target model.
                const targetKey = stateKeyForModel(target);

                //  Find the current set of hooks and expand it to include
                //  those required by the relationship to the current model.
                const existingHooks = outputHooks[targetKey];
                outputHooks[targetKey] = [
                    ...(existingHooks || []), () => {
                        //  Assign the foreign key value without dirtying.
                        model._setAttributeProxyStates({dirtying: false});
                        model[sourceAttribute] = target[destinationAttribute];
                        model._setAttributeProxyStates({dirtying: true});
                    }
                ];
            });
        }
    };

    //  Run DFS on the input set. This will visit implicitly included models
    //  too.
    models.forEach(visit);

    //  Process the output set and construct the return value.
    return outputModelSet.map(model => {
        //  Remove algorithm state-tracking property.
        delete model._dfsState;
        
        //  Retrieve the set of hooks for this model.
        const hooks = outputHooks[stateKeyForModel(model)];
        //  Create an aggregate callable.
        const invokeHooks = () => {
            if (!hooks) return;

            hooks.forEach(hook => hook());
        };
    
        return {model, invokeHooks};
    });
}

/**
*   Validate the shape of the supplied order components and resolve them into
*   an array of key, attribute type definition pairs. If there are no order
*   components provided, return null.
*/
const validateAndTransformOrderComponents = (orderComponents, attributes) => {
    //  Ensure a value exists.
    if (!orderComponents) return null;

    //  Ensure the shape is an array.
    if (!(orderComponents instanceof Array)) {
        if (resolveOneHotAttributeReference(orderComponents, attributes)) {
            //  Transform to an array.
            orderComponents = [orderComponents];
        }
        else throw new Error(
            'order() components must be array of or one or attribute reference'
        )
    };
    //  Resolve all elements in the array.
    orderComponents = orderComponents.map(component => (
        resolveOneHotAttributeReference(component, attributes)
    ))
    //  Assert all order components were successfully transformed.
    if (orderComponents.filter(c => !c).length > 0) throw new Error(
        'order() components must be array of or one or attribute reference'
        + ' (invalid array element(s))'
    );

    return orderComponents;
}

/**
*   A database query. Unlike other libraries, results must be explicitly
*   requested. The `first(n)` and `all()` methods retrieve rows asynchronously.
*
*   Queries are immutable but are used in chains by returning copies of
*   themselves with token and value lists being expanded for each modifying
*   call.
*/
class Query {
    /**
    *   See `Session.query` for documentation on constructing sessions. 
    */
    constructor(
        session, M, conditionTokens=null, conditionValues=null,
        orderComponents=null
    ) {
        this.session = session;
        this.M = M;
        this.conditionTokens = conditionTokens || [];
        this.conditionValues = conditionValues || [];
        this.orderComponents = orderComponents;
    }

    /**
    *   Return a copy of this query with the changes specified by the given
    *   update object. 
    */
    _copy(updateObject) {
        //  Create a copy.
        const next = new Query(
            this.session, this.M, this.conditionTokens, this.conditionValues,
            this.orderComponents
        );
        //  Perform updates.
        Object.keys(updateObject).forEach(key => {
            next[key] = updateObject[key];
        });

        //  Return the copy.
        return next;
    }

    /**
    *   Return this query with an additional set of conditions. The provided
    *   condition map should contain attribute names as keys and either scalar
    *   values or arrays with `['<comparator>', <scalar_value>]`. The
    *   comparator defaults to '='.
    * 
    *   The supplied conjunctive can be any boolean comparator, but should
    *   *not* be accepted from an untrusted source.
    * 
    *   Type validation is performed on all supplied values.
    */
    where(conditionMap, conjunctive='and') {
        //  Assert parameter type is valid.
        if (typeof conditionMap != 'object') {
            throw new Error('Invalid where() condition');
        }
        const {_schema: {attributes}} = this.M, newTokens = [], newValues = [];

        const conditionKeys = Object.keys(conditionMap);
        conditionKeys.forEach((key, i) => {
            //  Assert this is a valid attribute key and resolve the
            //  corresponding type.
            if (!(key in attributes)) {
                throw new SchemaError(`Out of schema attribute: ${ key }`);
            }
            const type = attributes[key];

            //  Comprehend comparator, scalar value pairs.
            let value = conditionMap[key], comparator = '=';
            if (value instanceof Array) [comparator, value] = value;

            //  Perform type validation.
            !type.validateOrDie(value);

            //  Expand token and value sets.
            newTokens.push(key);
            if (value === null) {
                //  Handle special null comparators with assertion.
                if (comparator == '=') comparator = 'is';
                if (comparator == '!=') comparator = 'is not';
                if (comparator != 'is' && comparator != 'is not') {
                    throw new Error(
                        `Invalid comparator for null: ${ comparator }`
                    );
                }
            }
            
            newTokens.push(comparator);
            newTokens.push('$' + (this.conditionValues.length + i + 1));
            newValues.push(value);

            if (i != conditionKeys.length - 1) newTokens.push(conjunctive);
        });
        
        //  Return next query.
        return this._copy({
            conditionTokens: [...this.conditionTokens, ...newTokens],
            conditionValues: [...this.conditionValues, ...newValues]
        });
    }

    /**
    *   Return a query with an `AND` conjunctive appened.
    */
    and() {
        return this._copy({
            conditionTokens: [...this.conditionTokens, 'and']
        });
    }

    /**
    *   Return a query with an `OR` conjunctive appended. 
    */
    or() {
        return this._copy({
            conditionTokens: [...this.conditionTokens, 'or']
        });
    }

    /**
    *   Return a query with the given ordering. The supplied ordering should be
    *   a list of one-hot attribute name, order maps, where the per-attribute
    *   order is either 'asc' or 'desc'. Note the order should *not* be
    *   accepted from an un-trusted source.
    */
    order(orderComponents) {
        if (!orderComponents) return this._copy({orderComponents: null});
        const {_schema: {attributes}} = this.M;

        //  Permit single item in leiu of an array.
        if (resolveOneHotAttributeReference(orderComponents, attributes)) {
            orderComponents = [orderComponents];
        }

        //  Resolve attribute references into key, attribute type definition
        //  pairs and assert shape.
        orderComponents = validateAndTransformOrderComponents(
            orderComponents, attributes
        );

        //  Return the updated query.
        return this._copy({orderComponents});
    }

    /**
    *   A protected variant of order component assignment for order component
    *   sets that have already been transformed and validated. Leveraged by
    *   relationship proxies.
    */
    _withValidatedOrder(orderComponents) {
        return this._copy({orderComponents});
    }


    /**
    *   Asynchronously load and reconstruct the models specified by this query,
    *   to the given limit if one is provided.
    */
    async _loadModels(limit=null) {
        const {conditionTokens, conditionValues, orderComponents} = this,
            {_schema: {collection}} = this.M;

        //  Retrieve rows.
        const {rows} = await this.session.emit(`
            select * from ${ collection }
                where ${ 
                    conditionTokens.length ? conditionTokens.join(' ') : 'true'
                }
                ${ limit === null ? '' : 
                    `limit $${ this.conditionValues.length + 1 }` 
                }
                ${ !orderComponents ? '' : (
                    `order by ${ orderComponents.map(o => (
                        Object.keys(o)[0] + ' ' + Object.values(o)[0]
                    )) }`.join(', ')
                ) };
        `, [...this.conditionValues, ...(limit ? [limit] : [])]);
        
        //  Resolve each row into a model and return the result.
        return rows.map(r => this.session._resolveModel(this.M, r));
    }

    /**
    *   Return a promise resolving to the first number of models for this
    *   query. Note that if the specified count is higher than the number of
    *   matching models, less models than that will be returned. If count is 1,
    *   a single model or `null` will be returned.
    */
    async first(count=1) {
        const result = await this._loadModels(count);

        if (count == 1) return result.length ? result[0] : null;
        else return result;
    }

    /**
    *   Return as many models as are specified by this query. 
    */
    async all() {
        return this._loadModels();
    }
}

/**
*   Sessions are complex cursors that also track the set of loaded models to
*   ensure that duplicate row loading doesn't result in duplicate model
*   reconstruction, as well as to allow for automatic dirty-attribute update on
*   session commit. This is a minimalistic ORM session implementation, and
*   doesn't provide attribute or relationship refreshes unless they are
*   specifically queried. The justification for this approach is that lower
*   abstraction data model implementation share this behaviour. 
*
*   When a session is commited, all changes to models loaded by that session
*   are automatically emitted. The only time changes are eagerly emitted is
*   during coupling across relationships.
*
*   Sessions are locked unless in an active transaction. Attempting emit SQL
*   from a session that has been `commit()`ed without a subsequent `begin()`
*   will result in a `SessionStateError`.
*
*   `Session`s are constructed via `Database.session()`.
*/
class Session {
    /**
    *   This constructor is exclusively used by `Database.session()`. 
    */
    constructor(database, cursorSource) {
        this.database = database;
        this.cursorSource = cursorSource;

        //  Initialize and empty cursor, state, and transaction flag.
        this.cursor = null;
        this.state = {};
        this.transacting = false;
    }
    
    /**
    *   Emit SQL to the underlying cursor for this session, acquiring it and
    *   enter a transaction if needed. 
    */
    async emit(...args) {
        //  Lazy-load the cursor.
        if (!this.cursor) {
            this.cursor = await this.cursorSource();
            await this.begin();
        }

        //  Maybe emit to stdout.
        if (process.env.SAGO_EMIT_SQL) console.log(...args);

        try {
            return await this.cursor.query(...args);
        }
        catch (err) {
            process.stderr.write('Emit error for:\n' + args.join('\n') + '\n');
            throw err;
        }
    }

    /**
    *   Return a model of the given class for this given row. If the row has
    *   already been loaded by this session, perform a refresh operation on the
    *   existing model and return it. Otherwise, reconstruct a model for this
    *   row, then register and return it.
    */
    _resolveModel(M, row) {
        //  Unpack schema, resolve primary key value and use it to generate a
        //  state key.
        const stateKey = stateKeyForModelRow(M, row);

        let model = null;
        if (stateKey in this.state) {
            //  We already have this model loaded, we just need to refresh it.

            //  Retrieve the model and disable dirtying by attribute proxies.
            model = this.state[stateKey];
            model._setAttributeProxyStates({dirtying: false});
            //  Perform attribute refresh.
            Object.keys(row).forEach(key => {
                //  Ensure the attribute hasn't already been overwritten in
                //  memory.
                if (key in model._dirty) return;

                model[key] = row[key];
            });

            //  Re-enable dirtying by attribute proxies and fire refresh
            //  lifecycle hook.
            model._setAttributeProxyStates({dirtying: true});
            model.modelDidRefresh();
        }
        else {
            //  Reconstruct and register this model.
            model = new M(row, true);
            this.state[stateKey] = model;
            model._session = this;

            //  Fire reconstruction lifecycle hook.
            model.modelDidReconstruct();
        }

        return model;
    }

    /**
    *   Emit an attribute update for the given model, then clear its dirty
    *   set. This method is leveraged by relationship proxies.
    */
    async _emitOneUpdate(model) {
        const {_schema: {collection, pkAttribute}} = model.constructor,
            dirtyKeys = Object.keys(model._dirty);

        //  Fire pre-storage model lifecycle hook.
        model.modelWillStore();
        //  Emit update SQL.
        await this.emit(`
            update ${ collection }
                set ${
                    dirtyKeys.map((k, i) => k + ' = $' + (i + 2)).join(',')
                }
                where ${ pkAttribute } = $1;
        `, [model[pkAttribute], ...dirtyKeys.map(k => model[k])]);
        //  Clear dirty set, since model state no reflects in-database state.
        //  XXX: In the case of a rollback, we lost this information.
        Object.keys(model._dirty).forEach(k => delete model._dirty[k]);

        //  Fire post-storage model lifecycle hook.
        model.modelDidStore();
    }

    /**
    *   Begin a new transaction.
    */
    async begin() {
        //  Assert the session isn't already in a transaction.
        if (this.transacting) {
            throw new SessionStateError('Already in a transaction');
        }

        //  Begin a transaction at mark.
        await this.emit('begin transaction;');
        this.transacting = true;
    }

    /**
    *   Flush all updates made to loaded models and commit the underlying
    *   transaction. 
    */
    async commit() {
        //  Comprehend the models we need to update.
        const dirtyModels = Object.values(this.state).filter(model => (
            Object.keys(model._dirty).length > 0
        ));
        //  Emit updates for each dirty model.
        for (let i = 0; i < dirtyModels.length; i++) {
            await this._emitOneUpdate(dirtyModels[i]);
        }
        
        //  Emit the transaction commit and mark we are no longer in one.
        await this.emit('commit;');
        this.transacting = false;
    }

    /**
    *   Add all given models to this session. Models should only be added this
    *   way if they are newly constructed and need to be inserted into their
    *   respective collections. 
    */
    async add(...models) {
        //  Assert session state is okay.
        if (this.cursor && !this.transacting) {
            throw new SessionStateError('No transaction');
        }

        //  Topologically sort model set.
        let modelCreations = orderEphemeralModelsByRelationshipIntent(
            models
        );

        //  Iterate each provided model, inserting and registering it.
        for (let i = 0; i < modelCreations.length; i++) {
            const {model, invokeHooks} = modelCreations[i],
                {_session, constructor: {_schema: {
                    collection, attributes
                }}} = model;

            //  Assert the model belongs to the same database as this session.
            if (this.database._getModel(collection) !== model.constructor) {
                throw new ModelStateError(
                    `${ model.toString() } is a foreign model`
                );
            }

            //  Assert this model isn't loaded somewhere else.
            if (_session && _session != this) {
                throw new ModelStateError(
                    `${ model.toString() } belongs to another session`
                );
            }

            //  Comprehend which attributes have and don't have values. These
            //  are written to and read from the insert, respectively (as the
            //  latter might have in-database defaults).
            const writeAttributes = Object.keys(attributes).filter(attr => (
                model[attr] !== null
            )), readAttributes = Object.keys(attributes).filter(attr => (
                model[attr] === null
            ));

            //  Register this model with this session.
            const stateKey = stateKeyForModelRow(model.constructor, model);
            this.state[stateKey] = model;
            model._session = this;

            //  Fire pre-storage model lifecycle hook.
            model.modelWillStore();

            //  Emit the insert SQL for this model and retrieve the attribute
            //  set that might have in-database defaults.
            const {rows: {0: readValues}} = await this.emit(`
                insert into ${ collection }
                    ( ${ writeAttributes.join(', ') } )
                    values
                    ( ${ writeAttributes.map((a, i) => '$' + (i + 1)) })
                ${ readAttributes.length > 0 ? 
                    `returning ${ readAttributes.join(', ') }`
                    :
                    '' 
                };
            `, writeAttributes.map(a => model[a]));
            
            //  If this model was previously, deleted, we need to unlock its
            //  attribute proxies because it exists again now.
            model._setAttributeProxyStates({writable: true});
            //  Mark the model as being bound to a row. This disables some
            //  relationship modifications that are allowed for purely 
            //  ephemeral models.
            model._bound = true;

            //  Assign readback attributes onto the model without dirtying.
            if (readValues) {
                model._setAttributeProxyStates({dirtying: false});
                Object.keys(readValues).forEach(key => (
                    model[key] = readValues[key]
                ));
                model._setAttributeProxyStates({dirtying: true});
            }

            //  Fire post-storage model lifecycle hook.
            model.modelDidStore();

            //  Invoke creation hooks.
            invokeHooks();
        }

        if (models.length == 1) return models[0];
        return models;
    }

    /**
    *   Delete each of the given models from the session and database. Models
    *   deleted this way are write-locked to indicate effectless operations.
    */
    async delete(...models) {
        for (let i = 0; i < models.length; i++) {
            const model = models[i],
                {_schema: {collection, pkAttribute}} = model.constructor,
                stateKey = stateKeyForModelRow(model.constructor, model);

            //  Assert this model is in fact loaded by this session.
            if (!(stateKey in this.state)) {
                throw new ModelStateError(
                    `${ Model.toString() } isn't present in session it was 
                    deleted from
                `.replace(/\s+/g, ' '));
            }

            //  Remove the model from this sessions internal state.
            delete this.state[stateKey];
            //  Remove the session from the model and write-lock it.
            model._session = null;
            model._setAttributeProxyStates({writable: false});

            //  Emit the deletion SQL.
            await this.emit(`
                delete from ${ collection }
                    where ${ pkAttribute } = $1;
            `, [model[pkAttribute]]);
        }
    }

    /**
    *   Abrubtly close this session. Under normal use, the transaction should
    *   be committed or rolled back first.
    */
    async close() {
        if (!this.cursor) return;
        await this.cursor.release();
    }

    async rollback() {
        //  TODO.
    }

    /**
    *   Generate a query targeting the given model class. 
    */
    query(M) {
        //  Assert this model belongs to the same database as this session.
        if (this.database._getModel(M.collection) != M) {
            throw new ModelStateError(`${ M.name } is a foreign model`);
        }

        return new Query(this, M);
    }
}

//  Exports.
module.exports = { Session, validateAndTransformOrderComponents };
