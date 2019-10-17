/**
*   Database session and query machinery definitions. Database sessions are
*   accessed through their parent databases, and queries are created indirectly
*   through sessions. 
*/
const { 
    SessionStateError, ModelStateError, RelationalAttributeError
} = require('./errors');
const { OneRelationProxy, relationProxiesAttachedTo } = require('./relations');
const { Query } = require('./query');
const { SideEffectAssignment, uniqueElements } = require('./utils');

/**
*   Return a key to uniquely identify the given model in a session state. 
*/
const stateKeyForModelRow = (M, row) => {
    const {_schema: {collection, pkAttribute}} = M, pkValue = row[pkAttribute];
        
    return [collection, pkValue].join('_');
}

/**
*   Return a key to uniquely identify the given model. 
*/
const stateKeyForModel = model => (
    stateKeyForModelRow(model.constructor, model)
);

//  XXX: Only returns ephemeral.
/**
*   Compute a topological sort of the given set of models by their
*   relationships (with many-sides first). This has the side-effect of
*   including all models that are not in the input set, but can be reached
*   via relationships, in the output set.
*/
const topoSortModelsByRelations = models => {
    //  TODO: Cycle handling.

    //  Expand the model set to include inbound relationship intents. This
    //  ensures that many-sides are included in the set if their corresponding
    //  one-sides are, since the depth first search only visits one-sides from
    //  many-sides.

    //  TODO: Modifications BFS to all models, then reduce to entry set.
    const reachableByIntents = [];
    const expandFrom = model => {
        //  Add this model if it isn't already present.
        if (models.indexOf(model) == -1) models.push(model);

        //  Visit each many-side model that intends to relate to this model as
        //  a one-side.
        model._inboundRelationshipIntentModels.forEach(model => {
            if (models.indexOf(model) == -1) expandFrom(model);
        });
        model._relationshipIntents.forEach(({oneSideModel}) => {
            expandFrom(oneSideModel);
            reachableByIntents.push(oneSideModel);
        });

    };
    [...models].forEach(expandFrom);
    models = models.filter(model => reachableByIntents.indexOf(model) == -1);

    //  Depth-first search the model set, additionally visiting models that are
    //  a one-side to the current models many-side.
    const result = [], visit = model => {

        //  Check the search state of this model.
        if (model._visitState == 2) return;
        if (model._visitState == 1) throw new Error(
            'Cycle handling not implemented'
        );
        
        //  Update this models state as visit (in progress).
        model._visitState = 1;
        //  Visit neighbors.
        model._relationshipIntents.forEach(({oneSideModel}) => visit(oneSideModel));
        //  Update this models state as visited (complete).
        model._visitState = 2;

        //  Add the model to the output set.
        if (!model._session || (
            model._session.deletions.indexOf(model) >= 0
        )) result.push(model);
    };
    models.forEach(visit);

    //  Return the resultant ordered set.
    result.reverse();
    return uniqueElements(result);
}

/**
*   Assert that all foreign keys on the given model that are non-nullable are
*   either assigned a value or have a pending relationship intent.
*/
const assertRelationalAttributesValidForModel = model => {
    //  Iterate each attribute of this model, asserting found foreign keys
    //  are valid.
    const attributes = model.constructor._schema.attributes;
    Object.keys(attributes).forEach(attribute => {
        const type = attributes[attribute];
        //  Ensure this is a non-nullable foreign key.
        if (!type.fkAttributeReference || type.isNullable) return;

        if (model[attribute] !== null) return;

        //  Ensure we don't have a pending relationship intent (which
        //  satisfies this check).
        let intentExists = false;
        model._inboundRelationshipIntentModels.forEach(manySideModel => {
            manySideModel._relationshipIntents.forEach(({
                oneSideModel, sourceAttribute
            }) => {
                if (oneSideModel == model && (
                    sourceAttribute == attribute
                )) intentExists = true;
            });
        });
        if (!intentExists) throw new RelationalAttributeError(
            model, attribute
        );
    });
}

/**
*   Sessions are the centeralized database interaction mechanism. They manage
*   row to model mappings and transactions. All operations performed on models
*   by a session are batched and occur at commit time.
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
            model = new M(row, this);
            this.state[stateKey] = model;
            model._session = this;

            //  Fire reconstruction lifecycle hook.
            model.modelDidReconstruct();
        }

        return model;
    }

    _oneSideModelsForManySideModel(manySideModel) {
        const manySideM = manySideModel.constructor;

        return Object.values(this.state).filter(model => {
            if (Object.values(model.constructor._schema.identities).filter(identity => {
                //  Match models who have a foreign key pointing at this model.

                if (!identity.type.fkAttributeReference) return false;
                const destinationIdentity = this.database._attributeReferenceToIdentity(
                    identity.type.fkAttributeReference
                );
                return destinationIdentity.M == manySideM && model[identity.attribute] == manySideModel[destinationIdentity.attribute];
            }));
        });
    }

    /**
    *   Emit an attribute update for the given model, then clear its dirty
    *   set. This method is leveraged by relationship proxies.
    */
    async _emitModelUpdate(model) {
        if (!Object.keys(model._dirty).length) return;
        
        //  We first need to assert that all foreign keys present on the
        //  given model are assigned a value. Note we rely on the in-database
        //  diagnostic in the case that they are assigned a cosmetically
        //  correct but insane value.
        assertRelationalAttributesValidForModel(model);

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
        //  Clear dirty set, since model state now reflects in-database state.
        Object.keys(model._dirty).forEach(k => delete model._dirty[k]);

        //  Fire post-storage model lifecycle hook.
        model.modelDidStore();
    }

    async _emitModelCreate(model) {
        const {_schema: {attributes, collection}} = model.constructor;

        //  Comprehend which attributes have and don't have values. These
        //  are written to and read from the insert, respectively (as the
        //  latter might have in-database defaults).
        const writeAttributes = Object.keys(attributes).filter(key => (
            model[key] !== null
        )), readAttributes = Object.keys(attributes).filter(key => (
            model[key] === null
        ));

        //  Fire pre-storage model lifecycle hook.
        model.modelWillStore();

        //  Emit the insert SQL for this model and retrieve the attribute
        //  set that might have in-database defaults.
        const {rows: {0: readValues}} = await this.emit(`
            insert into ${ collection }
                ( ${ writeAttributes.join(', ') } )
                values
                ( ${ writeAttributes.map((a, i) => '$' + (i + 1)) } )
            ${ readAttributes.length > 0 ? 
                `returning ${ readAttributes.join(', ') }`
                :
                '' 
            };
        `, writeAttributes.map(a => model[a]));
        
        //  If this model was previously, deleted, we need to unlock its
        //  attribute proxies because it exists again now.
        model._setAttributeProxyStates({writable: true});

        //  Assign readback attributes onto the model without dirtying.
        if (readValues) {
            model._setAttributeProxyStates({dirtying: false});
            Object.keys(readValues).forEach(key => (
                model[key] = readValues[key]
            ));
            model._setAttributeProxyStates({dirtying: true});
        }

        //  Register this model with this session.
        const stateKey = stateKeyForModel(model);
        this.state[stateKey] = model;
        model._session = this;

        //  TODO: Run relationship intents and update models whose previous ID (in the dirty map) are being deleted.
        model._relationshipIntents.forEach(({
            oneSideModel, sourceAttribute, destinationAttribute
        }) => {
            oneSideModel[sourceAttribute] = new SideEffectAssignment(model[destinationAttribute]);
        });
        model._relationshipIntents = [];
        model._inboundRelationshipIntentModels = [];

        //  Fire post-storage model lifecycle hook.
        model.modelDidStore();
    }

    async _emitModelDelete(model) {
        const stateKey = stateKeyForModel(model),
            {_schema: {pkAttribute, collection}} = model.constructor;

        //  Remove the model from this sessions internal state.
        delete this.state[stateKey];
        //  Remove the session from the model and write-lock it.
        model._session = null;

        //  Emit the deletion SQL.
        await this.emit(`
            delete from ${ collection }
                where ${ pkAttribute } = $1;
        `, [model[pkAttribute]]);
    }

    /**
    *   Emit SQL to the underlying cursor for this session, acquiring it and
    *   enter a transaction if needed. 
    */
    async emit(...args) {
        //  Lazy-load the cursor.
        if (!this.cursor) this.cursor = await this.cursorSource();

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

    add(...models) {
        models = topoSortModelsByRelations(models).filter(model => {
            const {_session, constructor} = model,
                {_schema: {collection}} = constructor;

            //  Assert the model belongs to the same database as this session.
            if (this.database._getM(collection) != constructor) throw (
                new ModelStateError(`${ model } is a foreign model`)
            );

            //  Assert this model isn't loaded somewhere else.
            if (_session && _session != this) throw new ModelStateError(
                `${ model } belongs to another session`
            );
            
            assertRelationalAttributesValidForModel(model);
        
            model._setAttributeProxyStates({writable: true});

            if (this.deletions.indexOf(model) >= 0) {
                this.deletions.splice(this.deletions.indexOf(model), 1);
                return false;
            }
            return true;
        });

        this.creations = [...this.creations, ...models];
    }

    delete(...models) {
        models = models.filter(model => {
            const stateKey = stateKeyForModel(model);

            //  Assert this model is in fact loaded by this session.
            if (!(stateKey in this.state)) throw new ModelStateError(
                `${ model } isn't present in session it was deleted from`
            );

            //  If this deletion has any side effects on loaded relationships,
            //  discover and apply those.
            const relationProxies = relationProxiesAttachedTo(model, true);
            Object.values(relationProxies).forEach(relation => {
                const oneSide = relation instanceof OneRelationProxy;

                if (oneSide) {
                    //  Handle the remote side if this relation is loaded. Note
                    //  the remote side cannot be loaded without this side
                    //  being loaded too, so we're guarenteed to make the
                    //  the update if applicable (since this is a one-side).
                    if (relation.loaded) {
                        //  Retrieve the related model.
                        const relatedModel = relation.get();

                        //  If there is a model across this relationship,
                        //  update its remote side if there is one loaded.
                        if (relatedModel) {
                            const remoteSide = relation._findRemoteSideOn(
                                relatedModel
                            );

                            if (remoteSide.loaded) {
                                remoteSide._removeAsSideEffect(model);
                            }
                        }
                    }
                    
                    //  Clear the near-side of this relation.
                    relation._setAsSideEffect(null, true);
                    model[relation.sourceAttribute] = new SideEffectAssignment(null);
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

                        const allRelatedModels = this._oneSideModelsForManySideModel(model);

                        relatedModels = allRelatedModels.filter(model => {
                            const remoteSide = relation._findRemoteSideOn(model);
                            return remoteSide && remoteSide.loaded;
                        });
                    }

                    //  XXX: Some list manipulation is unnessesarily per-item.
                    relatedModels.forEach(relatedModel => {
                        //  Remove this model from the near side.
                        relation._removeAsSideEffect(relatedModel);

                        //  Find the remote side if it exists.
                        const remoteSide = relation._findRemoteSideOn(
                            relatedModel
                        );
                        //  Clear the remote side on the related model and its
                        //  foreign key. Note it's guarenteed to be loaded 
                        //  since this (its corresponsing many-side) is.
                        if (remoteSide) remoteSide._setAsSideEffect(null);
                        relatedModel[relation.sourceAttribute] = new SideEffectAssignment(null);
                    });
                }
            });

            model._setAttributeProxyStates({writable: false});

            if (this.creations.indexOf(model) >= 0) {
                this.creations.splice(this.creations.indexOf(model), 1);
                return false;
            }
            return true;
        });
        
        this.deletions = [...this.deletions, ...models];
    }

    async commit({close=false}={}) {
        await this.emit('begin transaction;');

        for (let i = 0; i < this.creations.length; i++) {
            await this._emitModelCreate(this.creations[i]);
        }
        const eagerUpdateSet = this.deletions.map(model => (
            this._oneSideModelsForManySideModel(model)
        )).flat();
        for (let i = 0; i < eagerUpdateSet.length; i++) {
            await this._emitModelUpdate(eagerUpdateSet[i]);
        }
        for (let i = 0; i < this.deletions.length; i++) {
            await this._emitModelDelete(this.deletions[i]);
        }
        const updateSet = Object.values(this.state);
        for (let i = 0; i < updateSet.length; i++) {
            if (this.creations.indexOf(updateSet[i]) >= 0) continue;
            await this._emitModelUpdate(updateSet[i]);
        }

        await this.emit('commit;');

        this.creations = [];
        this.earlyDeletions = [];
        this.deletions = [];

        if (close) await this.close();
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
    query(collectionReference) {
        const M = this.database._collectionReferenceToM(collectionReference);

        return new Query(this, M);
    }
}

//  Exports.
module.exports = { Session };
