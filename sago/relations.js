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
const { writeLockArray } = require('./utils');

//  Define a sentinel value that is used to identify truely unset values within
//  relation proxies.
const _sentinel = {};

/**
*   Return an attribute name, relationship proxy map containing all relation
*   proxies on the given model. By default only returns proxies that are
*   loaded, as ones that aren't generally shouldn't be operated on.
*/
const relationProxiesAttachedTo = (model, includeUnloaded=false) => {
    //  Create the map for result storage.
    const resultMap = {};

    //  Since relationship properties will often be non-eneumerable, we
    //  iterate all properties of the given model to find them.
    const relationshipExposure = model.constructor.prototype;
    Object.getOwnPropertyNames(relationshipExposure).forEach(attribute => {
        const value = model[attribute];

        //  Ensure we have a relation proxy in the correct load state.
        if (!(value instanceof RelationProxy)) return;
        if (!includeUnloaded && !value.loaded) return;

        //  Store the result.
        resultMap[attribute] = value;
    });

    return resultMap;
};

const setupAttributeLinkBetween = (host, target, sourceAttribute, destinationAttribute, removeFromRemoteSide) => {
    const isTargetEphemeral = !target._bound, isHostEphemeral = !host._bound,
        { registerRelationshipIntentOnEphemeral } = require('./model');

    if (isHostEphemeral && isTargetEphemeral) {
        //  Both these models are ephemeral, register the relationship
        //  intent between them for the session to realize once they're
        //  added to it.
        registerRelationshipIntentOnEphemeral(
            host, target, sourceAttribute,
            destinationAttribute
        );

        return null;
    }
    else if (!isTargetEphemeral && !isHostEphemeral) {
        //  This model is row bound and the destination already has an
        //  ID, form the relationship normally.

        //  Remove the host here from the remote side if there is one.
        if (removeFromRemoteSide) removeFromRemoteSide();

        //  Assign the foreign key value and value here.
        host[sourceAttribute] = target[destinationAttribute];
        return () => host._session._emitOneUpdate(host);
    }
    else {
        //  One model is ephemeral and the other is loaded; we need to
        //  add the ephemeral one to the loaded ones session as part of
        //  the operation.
        const session = isTargetEphemeral ? host._session : target._session;

        return async blockAdd => {
            if (!blockAdd) await session.add(isTargetEphemeral ? target : host);
            host[sourceAttribute] = target[destinationAttribute];
        };
    }
}

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
    get loaded() { return this._value !== _sentinel; }

    /**
    *   Return the remote side for this relation on the given model, if there
    *   is one. Will not return unloaded relations unless they're explicitly
    *   requested.
    */
    findRemoteSideOn(model, ifUnloaded=false) {
        //  Determine the class of the remote side.
        //  XXX: Ugly child-class awareness.
        const HostClass = this instanceof OneRelationProxy ?
            ManyRelationProxy : OneRelationProxy;

        //  Resolve the remote side.
        const remoteSide = HostClass.findOnModel(
            model, this.host.constructor, this.sourceAttribute
        );
        //  Ensure we should return it.
        if (!remoteSide || (!remoteSide.loaded && !ifUnloaded)) return null;

        return remoteSide;
    }

    /**
    *   A usage hook that should be invoked before this relation proxy is
    *   accessed for either read or write. Asserts that the load state and 
    *   operation type are valid, and assigns an initial value if it is an
    *   unloaded relation on an ephemeral host. 
    */
    _beforeAccess(isModification, initialValue) {
        //  There's nothing to do if this is a loaded relationship.
        if (this.loaded) return;

        //  Assert we aren't performing a modification on an un-loaded relation
        //  whose host is bound.
        if (isModification && this.host._bound) throw new ModelStateError(
            'Cannot modify un-loaded relation'
        );

        //  If the host is ephemeral and we aren't loaded, assign the initial
        //  value.
        if (!this.host._bound) this._value = initialValue;
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
        //  Assert the target is in the same session, if it is in one at all.
        if (model._session && this._session && (
            model._session != this.session
        )) throw new ModelStateError(
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
    _setAsSideEffect(value, forceAssignmentIfUnloaded=false) {
        //  If the relation is valueless, we haven't loaded it yet so there's
        //  no need for other side effects to worry about it. The caller can
        //  disable this behavior, which is leveraged by many-side relations
        //  taking the opportunity to load thier corresponding one-side during
        //  load.
        if (!this.loaded && !forceAssignmentIfUnloaded) return;

        this._value = value;
    }

    /**
    *   Assign a model to this relationship. This method handles coupling in
    *   both directions.
    */
    set(model, _blockAddOperations=false) {
        //  Prepare for work.
        this._beforeAccess(true, null);

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
            const remoteSide = this.findRemoteSideOn(this._value);
            if (remoteSide) remoteSide._removeAsSideEffect(this.host);
        }

        //  Create storage for any resultant asynchronous work.
        let writeOperation = null;
        if (model) {
            //  We are setting this relation to point to a non-null model.
            
            //  Assert the model is a valid friend.
            this._assertValidFriend(model);

            //  Form the relationship.
            writeOperation = setupAttributeLinkBetween(this.host, model, this.sourceAttribute, this.destinationAttribute, removeFromRemoteSide);

            //  Update the value here.
            this._value = model;
            //  Push to the new remote side if there is one.
            const newRemoteSide = this.findRemoteSideOn(model, true);
            if (newRemoteSide) newRemoteSide._pushAsSideEffect(
                this.host, !this.host._bound
            );
        }
        else {
            //  Remove the host here from the remote side if there is one.
            removeFromRemoteSide();

            //  Null out the foreign key value and the value here.
            this.host[this.sourceAttribute] = null;
            this._value = null;
        }

        //  If forming this relationship resulted in an asynchronous write
        //  operation, return it asynchronously.
        if (writeOperation) return writeOperation(_blockAddOperations);
    }

    /**
    *   Retrieve the model from this relationship. Synchronous if the value has
    *   already been loaded, asynchronous otherwise.
    */
    get() {
        //  Prepare for work.
        this._beforeAccess(false, null);

        //  The value here is already loaded, return it synchronously.
        if (this.loaded) return this._value;

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
        const { validateAndTransformOrderComponents } = require('./session');

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
                const [attribute, type, direction] = this.orderComponents[i],
                    invert = direction == 'desc';

                let value = type.compareValues(a[attribute], b[attribute]);
                if (invert) value *= -1;
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
        if (!this.loaded) {
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
        if (!this.loaded) return;

        this._value.splice(this._value.indexOf(model), 1);
    }

    /**
    *   Push a model into this relationship. This method handles coupling on
    *   all of the up to three sides.
    */
    push(model) {
        //  Prepare for work.
        this._beforeAccess(true, []);
        
        //  Assert the model is a valid friend...
        this._assertValidFriend(model);
        //  ...which includes its not being already present in this relation.
        if (this._value.indexOf(model) >= 0) throw new ModelStateError(
            'Duplicate model added to relation'
        );

        //  Resolve the remote side of the new friend model.
        const modelRemoteSide = this.findRemoteSideOn(model);

        //  Remove the new model from its existing remote side if there is one
        //  loaded with a non-null value. Note we've asserted above that the 
        //  model isn't in this relation already, which makes this condition
        //  complete.
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
        let writeOperation = setupAttributeLinkBetween(model, this.host, this.sourceAttribute, this.destinationAttribute, null);

        //  Update the relationship here.
        this._value.push(model);
        this._resort();

        //  Update the remote side if there is one loaded.
        if (modelRemoteSide) modelRemoteSide._setAsSideEffect(this.host);

        if (writeOperation) return writeOperation();
    }

    /**
    *   Remove a model from this relationship. This method handles de-coupling
    *   on both sides. 
    */
    remove(model) {
        //  Prepare for work.
        this._beforeAccess(true, []);
        
        //  Retrieve this index of the model to remove in the value here and
        //  assert it is contained.
        const i = this._value.indexOf(model);
        if (i == -1) throw new ModelStateError(
            'Non-present model removed from relation'
        );

        //  De-couple the models foreign key and remove from the value here.
        model[this.sourceAttribute] = null;
        this._value.splice(i, 1);

        //  Null the remote side if there is one leaded.
        const remoteSide = this.findRemoteSideOn(model);
        if (remoteSide) remoteSide._setAsSideEffect(null);

        //  Emit an update for the new friend model to prevent mismatch with
        //  relations loaded later. See `OneRelationProxy.set()` for a detailed
        //  description of that case.
        if (model._bound) return this.session._emitOneUpdate(model);
    }

    /**
    *   Retrieve the model list from this relationship. Synchronous if the
    *   value has already been loaded, asynchronous otherwise. Note the
    *   retrieved list is always a copy of the true relationship, since the
    *   caller may mutate it.
    */
    get() {
        //  Prepare for work.
        this._beforeAccess(false, []);

        //  The value here has already been loaded, return it synchronously.
        if (this.loaded) return this._getWritedLockedCopy();

        //  The value here hasn't been loaded yet, query the model list and
        //  resolve asynchronously.
        return new Promise(resolve => {
            this.session.query(this.friendM).where({
                [this.sourceAttribute]: this.host[this.destinationAttribute]
            })._withValidatedOrder(this.orderComponents).all().then(models => {
                //  Since we now know the state of all involved one-sides, we
                //  can load those.
                models.forEach(model => {
                    const remoteSideToInit = this.findRemoteSideOn(
                        model, true
                    );

                    //  If we found a remote side, initialize it.
                    if (remoteSideToInit) remoteSideToInit._setAsSideEffect(
                        this.host, true
                    );
                });

                //  Assign the value here and return a write-locked copy.
                this._value = models;
                resolve(this._getWritedLockedCopy());
            });
        });
    }
}

//  Exports.
module.exports = { 
    RelationProxy, OneRelationProxy, ManyRelationProxy,
    relationProxiesAttachedTo
};
