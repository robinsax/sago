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
const { 
    SideEffectAssignment, writeLockArray, getInstanceItems, getInstanceValues,
    assertModelsShareSession
} = require('./utils');
const { resolveOrderComponents } = require('./query');

//  Define a sentinel value that is used to identify truely unset values within
//  relation proxies.
const _sentinel = {};

/**
*   Return an attribute name, relationship proxy map containing all relation
*   proxies on the given model. By default only returns proxies that are
*   loaded, as ones that aren't generally shouldn't be operated on.
*/
const relationProxiesAttachedTo = (model, includeUnloaded=false) => (
    getInstanceItems(model, RelationProxy).reduce((result, {key, value}) => (
        //  Include the relation proxy in the result if it's in an appropriate
        //  load state.
        (value.loaded || includeUnloaded) ? {...result, [key]: value} : result
    ), {})
);

/**
*   Ensure that after commit-time, the foreign key between the two models will
*   be properly set up.
*
*   If the many-side model doesn't yet have a value in the destination
*   attribute, the assignment on the one-side model is deferred until the
*   involved session is next committed and it is left up to the session to
*   identify that error case if it is still present then.
*
*   As a side effect, if either model is not yet added 
*/
const setupForeignKeyBetween = (
    oneSideModel, manySideModel, sourceAttribute, destinationAttribute
) => {
    //  Sanity check.
    assertModelsShareSession(oneSideModel, manySideModel);

    if (manySideModel[destinationAttribute] === null) {
        //  There is not a destination value yet. We assume that it will exist
        //  after commit-time (for example if the many-side isn't row bound and
        //  the attribute has an in-database default) and simply register the
        //  intent.
        manySideModel._relationshipIntents.push({
            oneSideModel, sourceAttribute, destinationAttribute
        });
        oneSideModel._inboundRelationshipIntentModels.push(manySideModel);
    }
    else {
        //  Perform the assignment.
        oneSideModel[sourceAttribute] = new SideEffectAssignment(
            manySideModel[destinationAttribute]
        );

        manySideModel._ephemeralRelations.push({
            oneSideModel, sourceAttribute
        })
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
    static _findClassedOnModel(MatchClass, model, friendM, fkAttribute=null) {
        const matches = getInstanceValues(model, MatchClass).filter(proxy => (
            //  Match proxies with the correct friend model class, and source
            //  attribute if one was specified.
            proxy.friendM == friendM && (
                !fkAttribute || fkAttribute == proxy.sourceAttribute
            )
        ));

        //  Assert we haven't discovered an ambiguous result.
        if (matches.length > 1) throw new SchemaError(
            'Ambiguous relation proxy discovered'
        );

        //  Return the disovered proxy or null.
        return matches[0] || null;
    }

    /**
    *   Construct a relation proxy of the given class between the given model
    *   and collection. The collection reference can be either a collection
    *   name or model class. The provided relation ordering callable is used to
    *   determine the direction of the relationship. The foreign key attribute
    *   must be directly specified if there are multiple foreign keys (in the
    *   same direction) between the model and target collection. It will be
    *   detected automatically if null is provided. Any provided relationship
    *   configuration is passed directly to the constructed relation proxy.
    */
    static _classedFromModel(
        CreateClass, relationOrder, model, targetCollectionReference, 
        fkAttribute, relationConfig={}
    ) {
        //  Retrieve the database to which the provided model belongs.
        const {constructor: {_schema: {database}}} = model;

        //  Resolve the target model class from the target collection
        //  reference.
        const targetM = database._collectionReferenceToM(
            targetCollectionReference
        );
        
        //  Use the provided relation ordering callable to determine sides and
        //  resolve the schemas for each.
        const [manySideSchema, oneSideSchema] = relationOrder(
            model.constructor, targetM
        ).map(({_schema}) => _schema);

        //  Resolve the source (one-side) and destination (many-side)
        //  attributes.
        let sourceIdentity = null, destinationIdentity = null;
        if (fkAttribute) {
            //  An attribute was explicitly specified, use that.

            //  Retrieve the attribute identity and type, asserting they're
            //  valid.
            sourceIdentity = oneSideSchema.identities[fkAttribute];
            if (!sourceIdentity) throw new SchemaError(
                `${ oneSideSchema } has no attribute ${ fkAttribute }`
            );
            const sourceType = sourceIdentity.type;
            if (!sourceType.fkAttributeReference) throw new SchemaError(
                `Attribute ${ fkAttribute } of ${ 
                    oneSideSchema 
                } isn't a foreign key`
            )

            //  Resolve the destination identity.
            destinationIdentity = database._attributeReferenceToIndentity(
                sourceType.fkAttributeReference
            );
        }
        else {
            //  We need to discover the foreign key attribute ourselves.

            //  Iterate all attributes of the many-side.
            Object.keys(manySideSchema.attributes).forEach(attribute => {
                //  Retreive the type for this attribute and ensure it's a
                //  foreign key.
                const checkType = manySideSchema.attributes[attribute];
                if (!checkType.fkAttributeReference) return;

                //  Retreive the identity of the foreign key target attribute
                //  and ensure it belongs to the correct model.
                const checkIdentity = database._attributeReferenceToIdentity(
                    checkType.fkAttributeReference
                );
                if (checkIdentity.M._schema != oneSideSchema) return;

                //  This is a valid foreign key, assert we haven't previously
                //  discovered one. If we have, this relationship is ambiguous.
                if (sourceIdentity) throw new SchemaError(
                    `Ambiguous foreign key for relation between ${ 
                        oneSideSchema 
                    } (one) and ${ manySideSchema } (many)`
                );

                //  Store the discovered identities.
                sourceIdentity = manySideSchema.identities[attribute];
                destinationIdentity = checkIdentity;
            });

            //  Assert we discovered the identities.
            if (!sourceIdentity) throw new SchemaError(
                `Non-existant foreign key from ${ 
                    oneSideSchema 
                } (one) to ${ manySideSchema } (many)`
            );
        }

        //  Create a relation proxy of the desired class.
        const proxy = new CreateClass(
            model, sourceIdentity.attribute, destinationIdentity.attribute,
            targetM
        );
        //  Configure the relationship if configuration was provided.
        if (Object.keys(relationConfig).length) proxy._configure(relationConfig);
        //  Return the created relation proxy.
        return proxy;
    }

    /**
    *   Both relation proxy implementations share the properties set up here.
    */
    constructor(
        defaultValueProvider, host, sourceAttribute, destinationAttribute,
        friendM
    ) {
        this.host = host;
        this.sourceAttribute = sourceAttribute;
        this.destinationAttribute = destinationAttribute;
        this.friendM = friendM;

        //  Initialize the value container for this relation proxy. If the host
        //  model is row-bound, it is initialized as being unloaded. Otherwise,
        //  it can safely initialize with its default value.
        this._value = this.host._session ? _sentinel : defaultValueProvider();
    }

    /**
    *   Whether or not this relationship is loaded. 
    */
    get loaded() { return this._value !== _sentinel; }

    _forceUnload() {
        this._value = _sentinel;
    }

    /**
    *   Return the remote side for this relation on the given model, if there
    *   is one. Will not return unloaded relations unless they're explicitly
    *   requested.
    */
    _findRemoteSideOn(model, ifUnloaded=false) {
        //  Determine the class of the remote side.
        //  XXX: Ugly child-class awareness.
        const HostClass = this instanceof OneRelationProxy ?
            ManyRelationProxy : OneRelationProxy;

        //  Resolve the remote side.
        const remoteSide = HostClass.findOnModel(
            model, this.host.constructor, this.sourceAttribute
        );
        //  Ensure we found a remote relation proxy in an appropriate load
        //  state.
        if (!remoteSide || (!remoteSide.loaded && !ifUnloaded)) return null;

        return remoteSide;
    }

    /**
    *   Assert this relationship is loaded. Called as a modification
    *   precondition assertion.
    */
    _assertLoaded() {
        if (!this.loaded) throw new ModelStateError(
            `Cannot perform write operation on unloaded relation ${ this }`
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
        //  Assert the model is of the correct class.
        if (!(model instanceof this.friendM)) throw new SchemaError(
            `Invalid model class for ${ model } (expected ${ 
                this.friendM._schema 
            })`
        );

        //  Ensure that if both the involved models belong to sessions, they
        //  belong to the same one.
        if (this.host._session && model._session && (
            model._session != this.host._session
        )) throw new ModelStateError(
                `Session mismatch between ${ 
                    this.host 
                } (relationship host) and ${
                    model
                } (joining model)`
            );
    }

    /**
    *   A stub for relation configuration.
    */
    _configure(options) { 
        throw new Error('Invalid relationship configuration');
    }
}

/**
*   A relation proxy that lives on one-side models. 
*/
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
    static fromModel(model, targetCollectionReference, fkAttribute=null) {
        return RelationProxy._classedFromModel(
            OneRelationProxy, (a, b) => [a, b], model,
            targetCollectionReference, fkAttribute
        );
    }

    /**
    *   A constructor override to provide the default value for this class. 
    */
    constructor(...args) {
        super(() => null, ...args);
    }
    
    /**
    *   Assign the value of this relationship without triggering side effects.
    *   This should only be called as a result of side effects elsewhere.
    */
    _setAsSideEffect(value, forceAssignmentIfUnloaded=false) {
        //  If the relation is valueless, we haven't loaded it yet so there's
        //  no need for other side effects to worry about it. The caller can
        //  disable this behavior, which is leveraged by many-side relations
        //  taking the opportunity to load their corresponding one-side during
        //  load.
        if (!this.loaded && !forceAssignmentIfUnloaded) return;

        this._value = value;
    }

    /**
    *   Conditionally load this relation based on the foreign key attribute
    *   value on the host (i.e. if the foreign key is null we can load this
    *   relation as pointing nowhere). 
    */
    _maybeLoadImplicitly() {
        //  If the foreign key is null the related model is too.
        if (!this.loaded && this.host[this.sourceAttribute] === null) this._value = null;
    }

    /**
    *   If the host of this relation is currently present in a loaded remote
    *   side, remove it from there.
    */
    _maybeRemoveFromCurrentRemote() {
        //  Ensure we have something to do.
        if (!this.loaded || !this._value) return;

        //  Find the remote side and remove the host here from it as a side
        //  effect.
        const remoteSide = this._findRemoteSideOn(this._value);
        if (remoteSide) remoteSide._removeAsSideEffect(this.host);
    }

    /**
    *   Assign a model to this relationship. This method handles coupling in
    *   both directions.
    */
    set(model) {
        //  Prepare for work.
        this._maybeLoadImplicitly();
        this._assertLoaded();

        //  Ensure we actually have something to do.
        if (model === this._value) return;

        //  Remove the host from the existing remote side it belongs to if
        //  there is one.
        this._maybeRemoveFromCurrentRemote();

        if (model) {
            //  We are setting this relation to point to a non-null model.
            
            //  Assert the model is a valid friend.
            this._assertValidFriend(model);

            //  Set up the foreign key attribute link.
            setupForeignKeyBetween(
                this.host, model, this.sourceAttribute,
                this.destinationAttribute
            );

            //  Update the value here.
            this._value = model;

            //  Push to the new remote side if there is one loaded.
            const newRemoteSide = this._findRemoteSideOn(model);
            if (newRemoteSide) newRemoteSide._pushAsSideEffect(this.host);
        }
        else {
            //  We're clearing this relation.

            //  Null out the foreign key value and the value here.
            this.host[this.sourceAttribute] = new SideEffectAssignment(
                null
            );
            this._value = null;
        }
    }

    /**
    *   Retrieve the model from this relationship. Synchronous if the value has
    *   already been loaded, asynchronous otherwise.
    */
    get() {
        //  Prepare for work.
        this._maybeLoadImplicitly();
        
        //  The value here is already loaded, return it synchronously.
        if (this.loaded) return this._value;

        //  The value here hasn't been loaded yet, load it and return the
        //  asynchronous work.
        return new Promise(resolve => {
            //  Load the target, set the value here and resolve with it.
            this.host._session.query(this.friendM).where({
                [this.destinationAttribute]: this.host[this.sourceAttribute]
            }).first().then(value => {
                this._value = value;

                resolve(value);
            });
        });
    }
}

/**
*   A relation proxy that lives on many-side models. 
*/
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
    *   specified. Order configuration can also be provided.
    */
    static fromModel(
        model, targetCollectionReference, fkAttribute=null, order=null
    ) {
        return RelationProxy._classedFromModel(
            ManyRelationProxy, (a, b) => [b, a], model, 
            targetCollectionReference, fkAttribute, {order}
        );
    }

    /**
    *   A constructor override that supplies the default value for this class
    *   and sets up many-side specific properties. 
    */
    constructor(...args) {
        super(() => [], ...args);

        //  Used to store validated order components for sorting this relation.
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
            `Invalid relationship configuration: ${ remaining } was unexpected`
        );

        //  Resolve the configured order components eagerly so malformed data
        //  being passed can be found in the traceback if the resolution fails.
        this.orderComponents = resolveOrderComponents(
            order, this.friendM._schema
        );
    }

    /**
    *   Re-sort the loaded value of this relation proxy based on the configured
    *   order.  
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
                //  Comprehend this order component.
                const {
                    identity: {attribute, type}, value: direction
                } = this.orderComponents[i];

                //  Use the type comparator to retrieve and integer result of
                //  the comparison.
                let value = type.compareValues(a[attribute], b[attribute]);
                //  Modify based on order.
                if (direction == 'desc') value *= -1;
                //  If this comparator found a difference between the two,
                //  return it. Note that if it didn't, the next gets a chance
                //  to.
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
    _pushAsSideEffect(model) {
        //  Ensure this relationship is loaded, if it isn't other side effects
        //  don't need to worry about it.
        if (!this.loaded) return;

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
        this._assertLoaded();
        this._assertValidFriend(model);

        //  Additionally assert the included model is not already present in
        //  this relation.
        if (this._value.indexOf(model) >= 0) throw new ModelStateError(
            `${ model } already in relation`
        );

        //  Resolve the remote side of the new friend model.
        const modelRemoteSide = this._findRemoteSideOn(model);
        //  If nessesary, remove the model from the instance of this relation
        //  it's currently present in.
        if (modelRemoteSide) modelRemoteSide._maybeRemoveFromCurrentRemote();

        //  Set up the foreign key attribute link.
        setupForeignKeyBetween(
            model, this.host, this.sourceAttribute, this.destinationAttribute
        );

        //  Update the relationship here.
        this._value.push(model);
        this._resort();

        //  Update the remote side if there is one loaded.
        if (modelRemoteSide) modelRemoteSide._setAsSideEffect(this.host);
    }

    /**
    *   Remove a model from this relationship. This method handles de-coupling
    *   on both sides. 
    */
    remove(model) {
        //  Prepare for work.
        this._assertLoaded();
        
        //  Retrieve this index of the model to remove in the value here and
        //  assert it is contained.
        const i = this._value.indexOf(model);
        if (i == -1) throw new ModelStateError(
            `${ model } isn't in the relation from which it was removed`
        );

        //  De-couple the models foreign key and remove from the value here.
        model[this.sourceAttribute] = new SideEffectAssignment(null);
        this._value.splice(i, 1);

        //  Null the remote side if there is one loaded.
        const remoteSide = this._findRemoteSideOn(model);
        if (remoteSide) remoteSide._setAsSideEffect(null);
    }

    /**
    *   Retrieve the model list from this relationship. Synchronous if the
    *   value has already been loaded, asynchronous otherwise. Note the
    *   retrieved list is immutable to prevent effectless operations being
    *   performed by the caller without an explicit copy.
    */
    get() {
        //  The value here has already been loaded, return it synchronously.
        if (this.loaded) return this._getWritedLockedCopy();

        //  The value here hasn't been loaded yet, query the model list and
        //  resolve asynchronously.
        return new Promise(resolve => {
            this.host._session.query(this.friendM).where({
                [this.sourceAttribute]: this.host[this.destinationAttribute]
            })._withValidatedOrder(this.orderComponents).all().then(models => {
                //  Respect ephemeral models that need to be included in this relation.
                models = [...models, ...this.host._ephemeralRelations.filter(({sourceAttribute}) => (
                    sourceAttribute == this.sourceAttribute
                )).map(({oneSideModel}) => oneSideModel)];

                //  Since we now know the state of all involved one-sides, we
                //  can load those.
                models.forEach(model => {
                    const remoteSideToInit = this._findRemoteSideOn(
                        model, true
                    );

                    //  If we found a remote side, initialize it.
                    if (remoteSideToInit) remoteSideToInit._setAsSideEffect(
                        this.host, true
                    );
                });

                //  Assign the value here and return a write-locked copy.
                this._value = models;
                this._resort(); // XXX: conditionally
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
