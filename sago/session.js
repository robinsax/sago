/**
*   Database session machinery. Sessions are accessed through their respective
*   databases and are used to generate queries as well as create, delete, and
*   update models.
*/
const { 
    NativeQueryError, ModelStateError, RelationalAttributeError,
    AttributeValueError
} = require('./errors');
const { 
    OneSideRelationProxy, relationProxiesAttachedTo 
} = require('./relations');
const { Query } = require('./query');
const { 
    _SideEffectAttributeAssignment, getInstanceValues, uniqueElements 
} = require('./utils');

//  Runtime mode options.
const EMIT_SQL_TO_STDOUT = process.env.SAGO_EMIT_SQL;
const EMIT_ERROR_CONTEXTS = process.env.SAGO_ERROR_CONTEXTS;

/**
*   Return a key to uniquely identify the given model in a session state.
*/
const stateKeyForModelRow = (M, row) => {
    const {_schema: {collection, primaryKey}} = M;

    //  Retrieve the primary key value from the row-like object and assert it
    //  is set.
    const primaryKeyValue = row[primaryKey.attribute];
    if (!primaryKeyValue) throw new Error(
        'State key generated for ephemeral model (this is a bug in sago)'
    );

    //  Return the key.
    return [collection, primaryKeyValue].join('_');
}

/**
*   Return a key to uniquely identify the given model. Note the model must
*   exist in-database for this key to be useful.
*/
const stateKeyForModel = model => (
    stateKeyForModelRow(model.constructor, model)
);

/**
*   Compute a topological sort of the given set of models by their relations
*   (with many-sides first). This has the side-effect of including all models
*   that are not in the input set, but can be reached via relations, in the
*   output set.
*
*   Note the output set consists of only models that match the provided filter,
*   but all models in the graph are traversed.
*/
const sortRelationGraph = (models, filter) => {
    //  TODO: Cycle handling.

    //  Perform a breadth-first search of all relations in which the models in
    //  the input set are involved, such that we can discover the complete
    //  graph. Note that only models that cannot be reached by crossing
    //  relation intents are used for the subsequent DFS entry set.
    const reachableByIntents = [], expandFrom = model => {
        //  Add this model if it isn't already present.
        if (models.indexOf(model) == -1) models.push(model);

        //  Visit each many-side model that intends to relate to this model as
        //  a one-side.
        model._relationalSet.inboundIntentModels.forEach(model => {
            //  Expand outwards, preventing an infinite loop.
            if (models.indexOf(model) == -1) expandFrom(model);
        });
        //  Visit each one-side model that intends to relate to this model as
        //  a many-side.
        model._relationalSet.intents.forEach(({oneSideModel}) => {
            expandFrom(oneSideModel);
            reachableByIntents.push(oneSideModel);
        });

    };
    //  Expand the input set for each model in it.
    [...models].forEach(expandFrom);
    //  Reduce the input set to only contain models unreachable by relation
    //  intents.
    models = models.filter(model => reachableByIntents.indexOf(model) == -1);

    //  Depth-first search the model set, visiting the models reachable by
    //  intents along those edges. We excluded these models from the input set
    //  above to prevent cycle mis-detection.
    const result = [], visit = model => {
        //  Check the search state of this model.
        if (model._visitState == 2) return;
        if (model._visitState == 1) throw new Error(
            'Cycle handling not implemented'
        );
        
        //  Update this models state as visit (in progress).
        model._visitState = 1;
        //  Visit neighbors.
        model._relationalSet.intents.forEach(({oneSideModel}) => {
            visit(oneSideModel);
        });
        //  Update this models state as visited (complete).
        model._visitState = 2;

        //  Add the model to the output set if it isn't row bound.
        if (filter(model)) result.push(model);
    };
    //  Visit each model in the output set.
    models.forEach(visit);

    //  Return the resultant ordered set.
    result.reverse();
    return uniqueElements(result);
}

/**
*   Assert that all attributes on the given model that are non-nullable are
*   either assigned a value, are a foreign key with a pending relationship
*   intent, or have an in-database default value if this is preconditional to
*   an insert operation.
*/
const enforceAttributeExistance = (model, forCreate=false) => {
    //  Iterate each attribute of this model, asserting found foreign keys
    //  are valid.
    const identities = model.constructor._schema.attributeIdentities;
    Object.values(identities).forEach(identity => {
        const {attribute, type} = identity;

        //  Ensure this is a non-nullable value that contains null.
        if (type.isNullable || model[attribute] !== null) return;

        //  If this is preconditional to a create operation, ensure there isn't
        //  an in-database default that makes this attribute value valid for
        //  insert.
        if (forCreate && type.dbDefaultValue) return;

        //  If this isn't a foreign key throw a simple null-value error.
        if (!type.isForeignKey) throw (
            new AttributeValueError(identity, null, "Can't be null")
        );

        //  Assert we have a pending relationship intent.
        let intentExists = false;
        model._relationalSet.inboundIntentModels.forEach(manySideModel => {
            manySideModel._relationalSet.intents.forEach(({
                oneSideModel, sourceAttribute
            }) => {
                if (oneSideModel == model && (
                    sourceAttribute == attribute
                )) intentExists = true;
            });
        });
        if (!intentExists) throw new RelationalAttributeError(identity);
    });
}

/**
*   Sessions are the centeralized database interaction mechanism. They manage
*   row to model mappings and transactions. All operations performed on models
*   by a session are batched and occur at commit time. Operations performed
*   directly through sessions will result in side-effects on loaded models.
*/
class Session {
    /**
    *   This constructor is exclusively for use by parent database objects. 
    */
    constructor(database, cursorSource) {
        this.database = database;
        this.cursorSource = cursorSource;

        //  Initialize and empty cursor and transaction flag.
        this.cursor = null;

        //  Initialize the model tracking state and work queues.
        this.state = {};
        this.creations = [];
        this.deletions = [];
    }

    /**
    *   The complete set of models in this session, including ephemeral models
    *   staged for addition. 
    */
    get _allModels() {
        return [...Object.values(this.state), ...this.creations];
    }

    /**
    *   Return a model of the given class for this given row. If the row has
    *   already been loaded by this session, perform a refresh operation on the
    *   existing model and return it. Otherwise, reconstruct a model for this
    *   row, then register and return it.
    */
    _resolveModel(M, row) {
        //  Generate a state key for this model row.
        const stateKey = stateKeyForModelRow(M, row);

        let model = null;
        if (stateKey in this.state) {
            //  We already have this model loaded, we just need to refresh it.

            //  Retrieve the model and disable dirtying by attribute proxies.
            model = this.state[stateKey];
            model._dirtying = false;
            //  Perform attribute refresh.
            Object.keys(row).forEach(key => {
                //  Ensure the attribute hasn't already been overwritten in
                //  memory.
                if (key in model._dirty) return;

                model[key] = row[key];
            });

            //  Re-enable dirtying by attribute proxies and fire hydration
            //  lifecycle hook.
            model._dirtying = true;
            model.modelDidHydrate();
        }
        else {
            //  Reconstruct and register this model.
            this.state[stateKey] = model = new M(row, this);

            //  Initialize all possible one-side relations.
            this._loadOneSideRelationsForModel(model);

            //  Fire reconstruction lifecycle hook.
            model.modelDidReconstruct();
        }

        return model;
    }

    /**
    *   Initialize all one-side relations for the given model that contain an
    *   already loaded model. Note this should only happen directly after
    *   reconstruction of the provided model.
    */
    _loadOneSideRelationsForModel(model) {
        //  XXX: Consider if the related model is pending deletion.
        //  XXX: Optimize.

        //  Discover all one-side relations on this model.
        getInstanceValues(model, OneSideRelationProxy).forEach(proxy => {
            const {friendM, sourceAttribute, destinationAttribute} = proxy,
                destinationValue = model[sourceAttribute];

            //  If the foreign key is null, we simply initialize the relation
            //  as null.
            if (destinationValue === null) {
                proxy._setAsSideEffect(null, true);
                return;
            }

            //  Discover in-session models that have the required destination
            //  for this relation.
            const matches = this._allModels.filter(otherModel => (
                otherModel instanceof friendM && (
                    otherModel[destinationAttribute] == destinationValue
                )
            ));

            //  Ensure one match was found. If more than one was found,
            //  attributes are impendent and this operation is impossible.
            //  XXX: Nicer behaviour here? Requires programmer context
            //       awareness.
            if (matches.length != 1) return;

            //  Initialized the relation proxy with the match.
            proxy._setAsSideEffect(matches[0], true);
        });
    }
    
    /**
    *   Return all one-side models that have a relation to the given many-side
    *   model.
    */
    _oneSideModelsForManySideModel(manySideModel) {
        //  XXX: Optimize with better schema comprehension data-structures.

        //  Reference the many side model class we're looking for and its set
        //  of ephemeral relations
        const manySideM = manySideModel.constructor,
            {ephemeralRelations} = manySideModel._relationalSet;

        //  Filter the set of models in this session, matching models that have
        //  an assigned foreign key directed at the given many-side model, or
        //  an ephemeral relation to it.
        return this._allModels.filter(model => {
            //  Check whether this model is ephemerally related to the given
            //  many side model. If so, match this model.
            if (ephemeralRelations.filter(({oneSideModel}) => (
                oneSideModel == model
            )).length > 0) return true;

            //  Iterate each attribute of this model, matching foreign keys
            //  directed at the given many-side model.
            const identities = model.constructor._schema.attributeIdentities;
            return Object.values(identities).filter(identity => {
                //  Ensure this is a foreign key.
                if (!identity.type.isForeignKey) return false;

                //  Inspect the destination identity of this foreign key to see
                //  if it is an attribute of the given many-side model, and has
                //  the value on that model assigned.
                const check = identity.type.foreignKeyDestinationIdentity;
                return check.M == manySideM && (
                    model[identity.attribute] == manySideModel[check.attribute]
                );
            }).length > 0;
        });
    }

    /**
    *   A side-effect hook for queries that delete rows. Updates the state of
    *   any involved loaded models appropriately. Note the invoking query must
    *   ensure that the value for the primary key of the relevant collection is
    *   included in the provided row. 
    */
    _queryDeletedRow(M, row) {
        const stateKey = stateKeyForModelRow(M, row);

        //  Ensure we the model for this row in our row-bound set.
        if (!(stateKey in this.state)) return;

        //  Retrieve the model and remove its row-bound mark. Note we don't
        //  remove the model from our row-bound set, that happens at commit
        //  time.
        //  XXX: Consider the latter.
        const model = this.state[stateKey];
        model._bound = false;

        //  Apply any side effects on other loaded models the deletion of this
        //  model has.
        this._applyRelationalDeletionSideEffects(model);
    }

    /**
    *   Apply any relational side effects resulting from the deletion of the
    *   given model. This involves tearing down the relations proxied on the
    *   given model, as well as updating any remote side relation proxies in
    *   which it is involved.
    */
    _applyRelationalDeletionSideEffects(model) {
        //  XXX: This depends on a near-side relation proxy to exist for each
        //       remote side one, which may not be the case.

        //  If this deletion has any side effects on loaded relationships,
        //  discover and apply those.
        const relationProxies = relationProxiesAttachedTo(model, true);
        Object.values(relationProxies).forEach(relation => {
            const oneSide = relation instanceof OneSideRelationProxy;

            if (oneSide) {
                //  Handle the remote side if this relation is loaded. Note
                //  the remote side cannot be loaded without this side
                //  being loaded too, so we're guarenteed to make the
                //  the update if applicable (since this is a one-side).
                //  XXX: As above - it could exist if the near side is never
                //       defined.

                if (relation.loaded) {
                    //  Retrieve the related model.
                    const relatedModel = relation.get();

                    //  If there is a model across this relationship,
                    //  update its remote side if there is one loaded.
                    if (relatedModel) {
                        const remoteSide = relation._findRemoteSideOn(
                            relatedModel
                        );

                        if (remoteSide) remoteSide._removeAsSideEffect(model);
                    }
                }
                
                //  Clear the near-side of this relation, as well as the true
                //  value of the foreign key.
                relation._setAsSideEffect(null, true);
                model[
                    relation.sourceAttribute
                ] = new _SideEffectAttributeAssignment(null);
            }
            else {
                //  This is a many-side relation.

                //  Retrieve the set of loaded related models.
                let relatedModels = null;
                if (relation.loaded) {
                    relatedModels = relation.get();
                }
                else {
                    //  We need to manually discover all models with a loaded
                    //  one side relation where the deleting model is the value.
                    relatedModels = this._oneSideModelsForManySideModel(model);
                }

                relatedModels.forEach(relatedModel => {
                    //  Remove this model from the near side.
                    relation._removeAsSideEffect(relatedModel);

                    //  Find the remote side if it exists and is loaded.
                    const remoteSide = relation._findRemoteSideOn(
                        relatedModel
                    );
                    //  Clear the remote side on the related model and its
                    //  foreign key.
                    if (remoteSide) remoteSide._setAsSideEffect(null);
                    relatedModel[
                        relation.sourceAttribute
                    ] = new _SideEffectAttributeAssignment(null);
                });
            }
        });
    }

    /**
    *   Manage and emit an attribute update for the given model.
    */
    async _emitModelUpdate(model) {
        const dirtyAttributes = Object.keys(model._dirty);

        //  Ensure there's something to do.
        if (!dirtyAttributes.length) return;
        
        //  Enforce non-null constraints.
        enforceAttributeExistance(model);
        //  Fire pre-storage model lifecycle hook.
        model.modelWillStore();

        //  Construct an object containing the update attribute key, value set.
        const write = dirtyAttributes.reduce((result, attribute) => (
            {...result, [attribute]: model[attribute]}
        ), {});

        //  Emit the update.
        const M = model.constructor, {primaryKey} = M._schema;
        await this.query(M).where({
            [primaryKey.attribute]: model[primaryKey.attribute]
        }).update(write);

        //  Clear dirty set, since model state now reflects in-database state.
        dirtyAttributes.forEach(k => delete model._dirty[k]);
        //  Fire post-storage model lifecycle hook.
        model.modelDidStore();
    }

    /**
    *   Manage and emit a row creation and binding for the given model. 
    */
    async _emitModelCreate(model) {
        //  Ensforce non-null constraints.
        enforceAttributeExistance(model, true);

        //  Comprehend the provided model.
        const M = model.constructor,
            identities = Object.values(M._schema.attributeIdentities);

        //  Sort attributes into those that are unset with an in-database
        //  default versus those that are set, to be read and written
        //  by the insert respectively. Note we have enforced that there are no
        //  attributes in an invalid state already.
        const reads = [], writes = {};
        //  XXX: Test this comprehensively.
        identities.forEach(({attribute}) => {
            if (attribute in model._dirty) {
                //  This attribute has been explicitly assigned.
                writes[attribute] = model[attribute];
            }
            else reads.push(attribute);
        });

        //  Fire pre-storage model lifecycle hook.
        model.modelWillStore();

        //  Emit the insert for this model and retrieve the newly-valued
        //  attribute set to hydrate the model with.
        const returned = await this.query(M).return(reads).insert(writes);

        //  Assign new attribute values onto the model without dirtying.
        Object.keys(returned).forEach(key => (
            model[key] = returned[key]
        ));

        //  Reset the dirty map of the model since it now reflects in-database
        //  values.
        Object.keys(model._dirty).forEach(k => delete model._dirty[k]);

        //  Add this model to the row-bound state of this session and set its
        //  local row-bound mark.
        const stateKey = stateKeyForModel(model);
        this.state[stateKey] = model;
        model._bound = true;

        //  Satisfy all registered relationship intents and reset the
        //  relational set.
        model._relationalSet.intents.forEach(({
            oneSideModel, sourceAttribute, destinationAttribute
        }) => {
            oneSideModel[sourceAttribute] = new _SideEffectAttributeAssignment(
                model[destinationAttribute]
            );
        });
        model._relationalSet.reset();

        //  Fire post-storage model lifecycle hook.
        model.modelDidStore();
    }

    /**
    *   Manage and emit a model deletion. 
    */
    async _emitModelDelete(model) {
        //  Comprehend the given model.
        const stateKey = stateKeyForModel(model), M = model.constructor,
            {primaryKey} = M._schema;

        //  Remove the model from the row-bound set and clear its local mark.
        delete this.state[stateKey];
        model._bound = false;

        //  Emit the deletion. Note we instruct the query not to apply side
        //  effects since we do that explicitly.
        await this.query(model.constructor).where({
            [primaryKey.attribute]: model[primaryKey.attribute]
        }).delete(false);

        //  Apply deletion side effects for this model.
        this._applyRelationalDeletionSideEffects(model);
    }

    //  XXX: Repackage into Query? It's only used there.
    /**
    *   Emit SQL to the underlying cursor for this session, lazy-loading the
    *   cursor if needed.
    */
    async _emit(sql, values=null) {
        //  Lazy-load the cursor.
        if (!this.cursor) this.cursor = await this.cursorSource();

        //  Maybe emit to stdout for diagnostics.
        if (EMIT_SQL_TO_STDOUT) console.log(sql, values);

        //  Emit to the cursor with safety.
        try {
            return await this.cursor.query(sql, values);
        }
        catch (err) {
            //  Maybe emit the context for this error to standard error.
            if (EMIT_ERROR_CONTEXTS) process.stderr.write(
                `====\nError context:\n\n${ sql }\n\n${ 
                    JSON.stringify(values)
                }\n====\n`
            );

            //  Raise a wrapped version of the node-postgres error.
            //  TODO: Better diagnostics.
            throw new NativeQueryError(err);
        }
    }

    /**
    *   Add all the models in the relational forest stemming from the provided
    *   model set that are not already in a session to this session. Relations
    *   are traversed in both directions (one-to-many and many-to-one). 
    * 
    *   Adding a model to this session schedules it for creation at commit
    *   time.
    * 
    *   The state of models already in this session is not mutated.
    */
    add(...models) {
        //  XXX: Check whether each model is _bound and handle if so.

        //  Transform the input set by traversing the relational forest
        //  stemming from the provided models, including all models that aren't
        //  row bound.
        //  XXX: Condition seems weird.
        models = sortRelationGraph(models, model => (
            !model._bound || this.deletions.indexOf(model) >= 0
        ));

        //  Add each model to this session. Note that it is invariant that each
        //  model is ephemeral.
        models.forEach(model => {
            //  Comprehend this model.
            const {_session: currentSession, constructor: M} = model,
                {collection} = M._schema;

            //  Assert the model belongs to the same database as this session.
            if (this.database._lookupM(collection) != M) throw (
                new ModelStateError(`${ model } is from a different database`)
            );

            //  Assert this model isn't loaded by another session.
            if (currentSession && currentSession != this) throw (
                new ModelStateError(`${ model } belongs to another session`)
            );
            //  Bind the model to this session.
            model._session = this;
        
            if (this.deletions.indexOf(model) >= 0) {
                //  This model has been queued for delete, remove it from that
                //  queue.
                this.deletions.splice(this.deletions.indexOf(model), 1);
            }
        });

        //  Expand the set of to-be-created models to include the models added
        //  by this operation.
        this.creations = uniqueElements([...this.creations, ...models]);
    }

    /**
    *   Delete the given models from this session.
    * 
    *   Deleting a model from this session schedules it for deletion from the
    *   database at commit time.
    */
    delete(...models) {
        //  Filter the provided set of models to only include those which need
        //  to be deleted from the database.
        models = models.filter(model => {
            //  Assert this model is in fact loaded by this session.
            if (model._session != this) throw new ModelStateError(
                `${ model } isn't present in session it was deleted from`
            );

            //  If this deletion has any side effects on loaded relationships,
            //  discover and apply those.
            this._applyRelationalDeletionSideEffects(model);

            //  Remove the model from this session.
            model._session = null;

            //  Schedule the deletion.
            if (model._bound) {
                //  Model is row-bound, we will need to emit a deletion.
                delete this.state[stateKeyForModel(model)];
                return true;
            }
            else {
                //  Model is still ephemeral but queued for creation, remove it
                //  from that queue.
                this.creations.splice(this.creations.indexOf(model), 1);
                return false;
            }
        });
        
        //  Expand the set of to-be-deleted models to include the models
        //  scheduled for deletion by this operation.
        this.deletions = uniqueElements([...this.deletions, ...models]);
    }

    /**
    *   Commit all changes performed by this session, including creations,
    *   updates, and deletions. These operations are sorted to ensure they
    *   are performed in a possible order if one exists. In the event of
    *   a commit time error, the transaction is rolled back.
    */
    async commit({close=false}={}) {
        //  Enter a transaction.
        await this._emit('begin transaction;');

        //  TODO: This needs to be modified such that rollbacks roll back
        //        model state, and ideally post-commit lifecycle hooks aren't
        //        invoked until the transaction is known to be successful.
        try {
            //  Emit creations.
            for (let i = 0; i < this.creations.length; i++) {
                await this._emitModelCreate(this.creations[i]);
            }
            
            //  Discover the set of models that have foreign keys that are
            //  known to point to models which are going to be deleted and so
            //  need to be updated eagerly.
            //  XXX: There are cases where this is insufficient.
            const eagerUpdateSet = this.deletions.map(model => (
                this._oneSideModelsForManySideModel(model)
            )).flat();

            //  Emit eager updates.
            for (let i = 0; i < eagerUpdateSet.length; i++) {
                await this._emitModelUpdate(eagerUpdateSet[i]);
            }

            //  Emit deletions.
            for (let i = 0; i < this.deletions.length; i++) {
                await this._emitModelDelete(this.deletions[i]);
            }

            //  Emit updates.
            const updateSet = Object.values(this.state);
            for (let i = 0; i < updateSet.length; i++) {
                await this._emitModelUpdate(updateSet[i]);
            }
        }
        catch (err) {
            //  Rollback the transaction.
            await this._emit('rollback;');
            
            //  TODO: Diagnostics.
            throw err;
        }

        //  Commit the transaction.
        await this._emit('commit;');

        //  Clear the schedules as they have been resolved.
        this.creations = [];
        this.deletions = [];

        //  Maybe close the underlying cursor for session.
        if (close) await this.close();
    }

    /**
    *   Close the underlying cursor for this session.
    */
    async close() {
        if (!this.cursor) return;
        await this.cursor.release();
    }

    /**
    *   Generate a query targeting the given model class. Queries are used to
    *   perform all database manipulation.
    */
    query(collectionReference) {
        const M = this.database._collectionReferenceToM(collectionReference);

        return new Query(this, M);
    }
}

//  Exports.
module.exports = { Session };
