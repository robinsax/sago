/**
*   Relationship management machinery. Relation proxies must explicitly be
*   defined as model attributes. Unlike with many other ORMs, they are
*   transparently not direct representations of the relationships; they need to
*   be interacted with to retrieve or modify those relationships, sometimes
*   asynchronously.
*
*   There are two relationship proxy implementations, one for the one-side of
*   relations and one for the many-side.
*/
const { ModelStateError, SchemaError } = require('./errors');
const { validateAndTransformOrderComponents } = require('./session');
const { writeLockArray } = require('./utils');

//  Define a sentinel value that is used to identify truely unset values within
//  relation proxies.
const _sentinel = Math.random();

/**
*   The base relation proxy class provides machinery shared between the 
*   one-side and many-side implementations. 
*/
class RelationProxy {
    /**
    *   Return the relation proxy of the given class pointing to the specified
    *   target on the provided model. If there are multiple relation proxies of
    *   the given class on that model, the specific foreign key attribute must
    *   also be supplied.
    */
    static _findClassedOnModel(
        RelationProxyClass, model, friendM, fkAttribute=null,
    ) {
        let found = null;

        //  Since relationship properties will often be non-eneumerable, we
        //  iterate all properties of the given model.
        const relationshipExposure = model.constructor.prototype;
        Object.getOwnPropertyNames(relationshipExposure).forEach(key => {
            const value = model[key],
                isRelationProxy = value instanceof RelationProxyClass;
            if (isRelationProxy && (value.friendM == friendM)) {
                //  Assert we haven't found an ambiguous proxy.
                if (found && !fkAttribute) throw new SchemaError(
                    'Ambiguous relation proxy discovered'
                );

                //  If there is no foreign key specified, or this one is,
                //  we've found a match but need to continue searching in
                //  case it's ambiguous.
                if (!fkAttribute || fkAttribute == value.sourceAttribute) {
                    found = value;
                }
            }
        });

        return found;
    }

    /**
    *   Construct a relation proxy of the given type from the given model,
    *   target reference, and optionally specific foreign key attribute. 
    */
    static _classedFromModel(
        RelationProxyClass, relationOrder, model, targetReference, 
        fkAttribute=null, relationshipConfig={}
    ) {
        const { Model } = require('./model');
        const {constructor: {_schema: {database}}, _session} = model;
    
        //  Assert the model is attached to a session.
        //if (!_session) throw new ModelStateError(
        //    'Cannot construct relationship on orphan model'
        //);

        //  Resolve the target model from the target reference.
        let targetM = null;
        if (typeof targetReference == 'string') {
            //  The reference is a collection name.
            targetM = database._getModel(targetReference);
        }
        else if (targetReference.prototype instanceof Model) {
            //  The reference is already a model class.
            targetM = targetReference;
        }
        //  Assert we found a reference
        if (!targetM) throw new SchemaError(
            `Invalid relation target reference ${ targetReference }`
        );

        //  Search the attributes of the appropriate model for the outbound
        //  foreign key.
        const fkAttributeSpecified = !!fkAttribute,
            [oneSide, manySide] = relationOrder(model.constructor, targetM),
            {_schema: {attributes}} = oneSide;
        let destinationAttribute = null;
        Object.keys(attributes).forEach(attribute => {
            const type = attributes[attribute], fkTarget = type.options.fk;
            //  Ensure this is a foreign key.
            if (!fkTarget) return;

            //  Comprehend the foreign key target we're checking.
            const [
                checkDestinationCollection, checkDestinationAttribute
            ] = fkTarget.split('.');
            //  Ensure it points to our destination.
            if (checkDestinationCollection != manySide._schema.collection) {
                return;
            }
            
            //  Assert we haven't already found a foreign key (or it was
            //  specified directly), since we don't want to continue under
            //  undefined behaviour.
            if (fkAttribute && !fkAttributeSpecified) throw new SchemaError(
                `Ambiguous foreign key between ${ 
                    oneSide._schema.collection 
                } (one) and ${ manySide._schema.collection } (many)`
            );

            //  Save the found link, but continue iterating in case it's
            //  ambiguous.
            fkAttribute = attribute;
            destinationAttribute = checkDestinationAttribute;
        });

        //  Assert we resolved the relation link.
        if (!destinationAttribute) throw new SchemaError(
            `Non-existant relation from ${ 
                oneSide._schema.collection 
            } (one) to ${ manySide } (many)`
        );

        //  Return a relation proxy of the appropriate class.
        const relationProxy = new RelationProxyClass(
            _session, model, fkAttribute, destinationAttribute, targetM
        );
        //  Configure the relationship if the option was supplied.
        if (Object.keys(relationshipConfig).length) {
            relationProxy._configure(relationshipConfig);
        }
        return relationProxy
    }

    /**
    *   Both relation proxy implementations share the same propeties, but some
    *   of their semantics are different between the two. 
    */
    constructor(
        session, host, sourceAttribute, destinationAttribute, friendM, 
        order=null
    ) {
        this.session = session;
        this.host = host;
        this.sourceAttribute = sourceAttribute;
        this.destinationAttribute = destinationAttribute;
        this.friendM = friendM;

        this.order = order;

        //  Initialize the value container for this relation proxy as the
        //  sentinel value so we can tell if it has been assigned, even to a
        //  null value or similar.
        this._value = _sentinel;
    }

    /**
    *   Whether or not this relationship is loaded. 
    */
    get loaded() { return this._value != _sentinel; }

    /** 
    *   Assert this relationship is loaded or throw a `ModelStateError`. If it
    *   hasn't been loaded, we can't modify it.
    * 
    *   Caviat: if both this model and the remote model are freshly
    *   constructed, allow the invoking write operation to continue since there
    *   is no relationship to load.
    */
    _assertLoadStateSharedWith(model) {
        //  Relationships can be constructed without being loaded if both models
        //  are ephemeral.
        if (!this.host._bound && (!model || !model._bound)) return;

        //  Assert this relationship is loaded.
        if (this._value == _sentinel) throw new ModelStateError(
            'Relationship assigned before being loaded'
        );
    }

    /**
    *   Assert the given model is a valid friend for this relationship and is a
    *   member of the same session as the host here. 
    */
    _assertValidFriend(model) {
        //  Assert the model exists.
        if (!model) throw new SchemaError(
            'Null model involved in relationship'
        )
        //  Assert the model is if the correct class.
        if (!(model instanceof this.friendM)) throw new SchemaError(
            'New relationship member has wrong class'
        );
        //  Assert the target is in the same session.
        if (model._session != this.session) throw new ModelStateError(
            'Relationship between disjoint sessions'
        );
    }

    /**
    *   A snub for relationship configuration. Because of the way on-model
    *   relationship caching works, relationships are configured after they are
    *   created.
    */
    _configure(options) { 
        throw new Error('Invalid relationship configuration');
    }
}

class OneRelationProxy extends RelationProxy {
    /**
    *   Find and return the described one-side relation proxy on the given
    *   model or return `null`.
    */
    static findOnModel(model, friendM, fkAttribute=null) {
        return RelationProxy._findClassedOnModel(
            OneRelationProxy, model, friendM, fkAttribute
        );
    }

    /**
    *   Construct and return a one-side relation proxy between the given model
    *   and referenced target, specifically using the given foreign key if it's
    *   specified. 
    */
    static fromModel(model, targetReference, fkAttribute=null) {
        return RelationProxy._classedFromModel(
            OneRelationProxy, (a, b) => [a, b], model, targetReference,
            fkAttribute
        );
    }
    
    /**
    *   Assign the value of this relationship without triggering side effects.
    *   This should only be called as a result of side effects elsewhere.
    */
    _setAsSideEffect(value) {
        //  If the relation is valueless, we haven't loaded it yet so there's
        //  no need for other side effects to worry about it.
        if (this._value == _sentinel) return;

        this._value = value;
    }

    /**
    *   Assign a model to this relationship. This method handles coupling in
    *   both directions.
    */
    set(model) {
        //  Assert that either these models are both ephemeral, or they belong
        //  to the same session.
        this._assertLoadStateSharedWith(model);

        //  Ensure we actually have something to do.
        if (model === this._value) return;

        //  Define a previous-relation cleanup helper.
        /**
        *   If there is a remote side to this relationship, remove the host
        *   model here from it.
        */
        const removeFromRemoteSide = () => {
            //  Ensure there's a currently a value.
            if (!this._value) return;

            //  Find the remote side and remove the host here from it as a side
            //  effect.
            const remoteSide = ManyRelationProxy.findOnModel(
                this._value, this.host.constructor, this.sourceAttribute
            );
            if (remoteSide) remoteSide._removeAsSideEffect(this.host);
        }

        if (model) {
            //  We are setting this relation to point to a non-null model.
            
            //  Assert the model is a valid friend.
            this._assertValidFriend(model);

            //  Form the relationship.
            const isEphemeral = !model._bound;
            if (!isEphemeral) {
                //  This model is row bound and the destination already has an
                //  ID, form the relationship normally. The host being
                //  ephemeral is asserted by _assertLoadStateSharedWith.

                //  Remove the host here from the remote side if there is one.
                removeFromRemoteSide();

                //  Assign the foreign key value and value here.
                this.host[this.sourceAttribute] = model[this.destinationAttribute];
                this._value = model;
            }
            else {
                const {
                    registerRelationshipIntentOnEphemeral 
                } = require('./model');

                //  Both these models are ephemeral, register the relationship
                //  intent between them for the session to realize once they're
                //  added to it.
                registerRelationshipIntentOnEphemeral(
                    this.host, model, this.sourceAttribute,
                    this.destinationAttribute
                );

                //  Update the value here.
                this._value = model;
            }

            //  Push to the new remote side if there is one.
            const newRemoteSide = ManyRelationProxy.findOnModel(
                model, this.host.constructor, this.sourceAttribute
            );
            if (newRemoteSide) newRemoteSide._pushAsSideEffect(
                this.host, isEphemeral
            );
        }
        else {
            //  Remove the host here from the remote side if there is one.
            removeFromRemoteSide();

            //  Null out the foreign key value and the value here.
            this.host[this.sourceAttribute] = null;
            this._value = null;
        }
        
        //  Emit an update of the host to propagate the relation to the
        //  database. This is nessesary because not doing so could create a
        //  mismatch with both the old and new remote sides if they load after
        //  this operation.
        if (this.host._bound) return new Promise(resolve => {
            this.session._emitOneUpdate(this.host).then(() => resolve())
        });
    }

    /**
    *   Retrieve the model from this relationship. Synchronous if the value has
    *   already been loaded, asynchronous otherwise.
    */
    get() {
        //  The value here is already loaded, return it synchronously.
        if (this._value != _sentinel) return this._value;
    
        //  The value here hasn't been loaded yet, load it and return
        //  asynchronously.
        return new Promise(resolve => {
            //  If the relation doesn't go anywhere return null.
            if (this.host[this.sourceAttribute] === null) {
                this._value = null;
                resolve(null);
                return;
            };

            //  Query the target and resolve.
            this.session.query(this.friendM).where({
                [this.destinationAttribute]: this.host[this.sourceAttribute]
            }).first().then(value => {
                this._value = value;

                resolve(value);
            });
        });
    }
}

class ManyRelationProxy extends RelationProxy {
    /**
    *   Find and return the described one-side relation proxy on the given
    *   model or return `null`.
    */
    static findOnModel(model, friendM, fkAttribute=null) {
        return RelationProxy._findClassedOnModel(
            ManyRelationProxy, model, friendM, fkAttribute
        );
    }

    /**
    *   Construct and return a one-side relation proxy between the given model
    *   and referenced target, specifically using the given foreign key if it's
    *   specified. 
    */
    static fromModel(model, targetReference, fkAttribute=null, order=null) {
        return RelationProxy._classedFromModel(
            ManyRelationProxy, (a, b) => [b, a], model, targetReference,
            fkAttribute, {order}
        );
    }

    /**
    *   A constructor override that sets up many-side specific properties. 
    */
    constructor(...args) {
        super(...args);

        this.orderComponents = null;
    }

    /**
    *   Return a write-locked copy of the current value of this relationship,
    *   which must be asserted as loaded by the calling context. 
    */
    _getWritedLockedCopy() {
        return writeLockArray(
            [...this._value], 
            "Can't mutate a relationship view directly, mutate the relation " +
            'proxy or copy the retrieval explicitly'
        );
    }

    /**
    *   Validate and accept order configuration.
    */
    _configure(options) {
        const {order, ...remaining} = options;
        //  Assert we didn't receive unwanted values.
        if (Object.keys(remaining).length) throw new Error(
            'Invalid relationship configuration'
        );

        //  Validate and transform the configured order components into a list
        //  of key, attribute type definition pairs, or null if none were
        //  supplied.
        this.orderComponents = validateAndTransformOrderComponents(
            order, this.friendM._schema.attributes
        );
    }

    /**
    *   Re-sort the loaded value of this attribute proxy based on the
    *   configured order.  
    */
    _resort() {
        //  Ensure there's something to do.
        if (!this.orderComponents) return;

        //  Define the comparator for the sort.
        /**
        *   Return a comparison result for the two given models, honouring each
        *   comparitor in order of their inclusion in the component list. 
        */
        const compareModels = (a, b) => {
            for (let i = 0; i < this.orderComponents.length; i++) {
                const [attribute, type] = this.orderComponents[i];

                const value = type.compareValues(a[attribute], b[attribute]);
                if (value > 0 || value < 0) return value;
            }

            return 0;
        };

        //  Perform the sort.
        this._value.sort(compareModels);
    }

    /**
    *   Push a model into this relationship without triggering side effects.
    *   This should only be called as a result of side effects elsewhere.
    */
    _pushAsSideEffect(model, isEphemeral=false) {
        //  Ensure this relationship is loaded, if it isn't other side effects
        //  don't need to worry about it. If the side effect is coming from a
        //  the remote side of an ephemeral relationship, we initialize this
        //  relationship instead.
        if (this._value == _sentinel) {
            if (isEphemeral) this._value = [];
            else return;
        }

        this._value.push(model);
        this._resort();
    }

    /**
    *   Remove a model from this relationship without triggering side effects.
    *   This should only be called as a result of side effects elsewhere.
    */
    _removeAsSideEffect(model) {
        //  Ensure this relationship is loaded, if it isn't other side effects
        //  don't need to worry about it.
        if (this._value == _sentinel) return;

        this._value.splice(this._value.indexOf(model), 1);
    }

    /**
    *   Push a model into this relationship. This method handles coupling on
    *   all of the up to three sides.
    */
    push(model) {
        //  Assert that either these models are both ephemeral, or they belong
        //  to the same session.
        this._assertLoadStateSharedWith(model);
        
        //  Assert the model is a valid friend...
        this._assertValidFriend(model);
        //  ...which includes its not being already present in this relation.
        if (this._value.indexOf(model) >= 0) throw new ModelStateError(
            'Duplicate model added to relation'
        )


        //  Resolve the remote side of the new friend model.
        const modelRemoteSide = OneRelationProxy.findOnModel(
            model, this.host.constructor, this.sourceAttribute
        );

        //  Remove the new model from its existing remote side if there is one
        //  loaded with a non-null value. Note we've asserted above that the model isn't in this
        //  relation already, which makes this condition complete.
        if (
            modelRemoteSide && modelRemoteSide.loaded && 
            model[this.sourceAttribute]
        ) {
            const currentModelFriend = modelRemoteSide.get(),
                currentModelFriendRemoteSide = ManyRelationProxy.findOnModel(
                    currentModelFriend, model.constructor, 
                    modelRemoteSide.sourceAttribute
                );

            //  If there is a alias of this remote side that currently exists,
            //  remove the new friend model from it.
            if (currentModelFriendRemoteSide) {
                currentModelFriendRemoteSide._removeAsSideEffect(model);
            }
        }

        //  Form the relationship.
        const isEphemeral = !model._bound;
        if (!isEphemeral) {      
            //  Assert the host here has a valid foreign key for assignment to the
            //  model.
            if (!this.host[this.destinationAttribute]) throw new ModelStateError(
                'Relationship created before host reference assigned'
            );
            
            //  Assign the foreign key value and add the the relationship here.
            model[this.sourceAttribute] = this.host[this.destinationAttribute];
        }
        else {
            const {
                registerRelationshipIntentOnEphemeral 
            } = require('./model');

            //  Both these models are ephemeral, register the relationship
            //  intent between them for the session to realize once they're
            //  added to it.
            registerRelationshipIntentOnEphemeral(
                model, this.host, this.sourceAttribute,
                this.destinationAttribute
            );
        }

        //  Update the relationship here.
        this._value.push(model);
        this._resort();

        //  Update the remote side if there is one loaded.
        if (modelRemoteSide) modelRemoteSide._setAsSideEffect(this.host);

        //  Emit an update for the new friend model. As described in 
        //  `OneRelationProxy`, we need to do this to prevent mismatch with
        //  old or new remote sides of this model that are loaded later.
        if (model._bound) return new Promise(resolve => {
            this.session._emitOneUpdate(model).then(() => resolve);
        });
    }

    /**
    *   Remove a model from this relationship. This method handles de-coupling
    *   on both sides. 
    */
    remove(model) {
        //  Assert that either these models are both ephemeral, or they belong
        //  to the same session.
        this._assertLoadStateSharedWith(model);

        //  Retrieve this index of the model to remove in the value here and
        //  assert it is contained.
        const i = this._value.indexOf(model);
        if (i == -1) throw new SchemaError(
            'Non-present model removed from relation'
        );

        //  De-couple the models foreign key and remove from the value here.
        model[this.contentFk] = null;
        this._value.splice(i, 1);

        //  Null the remote side if there is one leaded.
        const remoteSide = OneRelationProxy.findOnModel(
            model, this.host.constructor, this.sourceAttribute
        );
        if (remoteSide) remoteSide._setAsSideEffect(null);

        //  Emit an update for the new friend model to prevent mismatch with
        //  relations loaded later. See `OneRelationProxy.set()` for a detailed
        //  description of that case.
        if (model._bound) return new Promise(resolve => {
            this.session._emitOneUpdate(model);
            resolve();
        });
    }

    /**
    *   Retrieve the model list from this relationship. Synchronous if the
    *   value has already been loaded, asynchronous otherwise. Note the
    *   retrieved list is always a copy of the true relationship, since the
    *   caller may mutate it.
    */
    get() {
        //  The value here has already been loaded, return it synchronously.
        if (this._value != _sentinel) return this._getWritedLockedCopy();

        //  The value here hasn't been loaded yet, query the model list and
        //  resolve asynchronously.
        return new Promise(resolve => {
            this.session.query(this.friendM).where({
                [this.sourceAttribute]: this.host[this.destinationAttribute]
            })._withValidatedOrder(this.orderComponents).all().then(value => {
                this._value = value;

                resolve(this._getWritedLockedCopy());
            });
        });
    }
}

//  Exports.
module.exports = { RelationProxy, OneRelationProxy, ManyRelationProxy };
