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
    _SideEffectAttributeAssignment, getInstanceItems, getInstanceValues
} = require('./utils');
const { resolveOrderTemplate } = require('./query');

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
    if (oneSideModel._session && manySideModel._session && (
        oneSideModel._session != manySideModel._session
    )) throw new ModelStateError(
        `${ oneSideModel } (one-side) and ${ 
            manySideModel 
        } (many-side) are in different sessions`
    );

    if (manySideModel[destinationAttribute] === null) {
        //  There is not a destination value yet. We assume that it will exist
        //  after commit-time (for example if the many-side isn't row bound and
        //  the attribute has an in-database default) and simply register the
        //  intent.
        manySideModel._relationalSet.intents.push({
            oneSideModel, sourceAttribute, destinationAttribute
        });
        oneSideModel._relationalSet.inboundIntentModels.push(manySideModel);
    }
    else {
        //  Perform the assignment.
        oneSideModel[sourceAttribute] = new _SideEffectAttributeAssignment(
            manySideModel[destinationAttribute]
        );

        //  Register the fact that there is an inbound ephemeral relation with
        //  the many-side model so that if it loads attribute proxies later
        //  (but before commit time) they are aware of this relationship.
        manySideModel._relationalSet.ephemeralRelations.push({
            oneSideModel, sourceAttribute
        });
    }
}

/**
*   Relational sets are model instance metadata holders used to reduce the
*   impact of metadata on the model instance namespace. They track relation
*   proxies, relationship intents, and relations with bound (host) models to
*   ephemeral models. 
*
*   The module instantiation machinery is responsible for constructing these
*   objects.
*/
class _RelationalSet {
    /**
    *   Construct a relation set with initial values. 
    */
    constructor(model) {
        this.model = model;

        //  A cache of constructed relation proxies.
        this.proxyCache = {};
        
        //  Ephemeral models with a relationship intent towards the host model.
        this.inboundIntentModels = [];
        //  Foreign key attribute link descriptors to be resolved at session
        //  commit time.
        this.intents = [];
        //  Descriptors of relations to ephemeral models where this is the
        //  many side. Used to allow relation proxies to include intended
        //  relations on load.
        this.ephemeralRelations = [];
    }

    /**
    *   Resolve a relation proxy out of the cache here. Relation proxies must
    *   be cached to allow them to maintain state without being created
    *   unnessesarily. 
    */
    resolveRelationProxy(RelationProxyClass, destinationReference, options) {
        //  TODO: Support parallel relation proxies.
        //  XXX: Bad import.
        const { Model } = require('./model');

        //  Unpack the foreign key from the provided options set.
        const {fk: foreignKeyAttribute, ...remainingOptions} = options;

        //  Resolve a unique cache key for this relationship.
        const cacheKey = [
            RelationProxyClass.name,
            destinationReference.prototype instanceof Model ? 
                destinationReference._schema.collection
                :
                destinationReference,
            foreignKeyAttribute || '<inherent>'
        ].join('_');

        //  Check the on-model cache and populate if nessesary.
        const cache = this.model._relationalSet.proxyCache;
        if (!cache[cacheKey]) cache[cacheKey] = RelationProxyClass.fromModel(
            this.model, destinationReference, foreignKeyAttribute,
            remainingOptions
        );

        //  Return the relation proxy.
        return cache[cacheKey];
    }

    /**
    *   Reset the transactional elements of this relation set. Should only be
    *   invoked when the in-memory state is know to reflect the database. 
    */
    reset() {
        this.inboundIntentModels = [];
        this.intents = [];
        this.ephemeralRelations = [];
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
        MatchClass, model, friendM, foreignKeyAttribute=null
    ) {
        const matches = getInstanceValues(model, MatchClass).filter(proxy => ( 
            //  Match proxies with the correct friend model class, and source
            //  attribute if one was specified.
            proxy.friendM == friendM && (
                !foreignKeyAttribute || foreignKeyAttribute == proxy.sourceAttribute
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
        foreignKeyAttribute, relationConfig={}
    ) {
        //  Retrieve the database to which the provided model belongs.
        const {_schema: {database}} = model.constructor;

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
        if (foreignKeyAttribute) {
            //  An attribute was explicitly specified, use that.

            //  Retrieve the attribute identity and type, asserting they're
            //  valid.
            sourceIdentity = oneSideSchema.attributes[foreignKeyAttribute];
            if (!sourceIdentity) throw new SchemaError(
                `${ oneSideSchema } has no attribute ${ foreignKeyAttribute }`
            );
            const sourceType = sourceIdentity.type;
            if (!sourceType.foreignKeyAttributeReference) throw (
                new SchemaError(
                    `Attribute ${ foreignKeyAttribute } of ${ 
                        oneSideSchema 
                    } isn't a foreign key`
                )
            );

            //  Resolve the destination identity.
            destinationIdentity = sourceType.foreignKeyDestinationIdentity;
        }
        else {
            //  We need to discover the foreign key attribute ourselves.

            //  Iterate all attributes of the many-side.
            const manySideIdentities = manySideSchema.attributeIdentities;
            Object.values(manySideIdentities).forEach(identity => {
                const checkType = identity.type;

                //  Retreive the type for this attribute and ensure it's a
                //  foreign key.
                if (!checkType.isForeignKey) return;

                //  Retreive the identity of the foreign key target attribute
                //  and ensure it belongs to the correct model.
                const checkIdentity = checkType.foreignKeyDestinationIdentity;
                if (checkIdentity.M._schema != oneSideSchema) return;

                //  This is a valid foreign key, assert we haven't previously
                //  discovered one. If we have, this relationship is ambiguous.
                if (sourceIdentity) throw new SchemaError(
                    `Ambiguous foreign key for relation between ${ 
                        oneSideSchema 
                    } (one) and ${ manySideSchema } (many)`
                );

                //  Store the discovered identities.
                sourceIdentity = identity;
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
        if (Object.keys(relationConfig).length) proxy._configure(
            relationConfig
        );
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

    /**
    *   Force this relationship into an unloaded state. This should only be
    *   done as a side effect of assignments to the host attribute where the
    *   new value doesn't correspond to a loaded model. 
    */
    _forceUnload() {
        this._value = _sentinel;
    }

    _maybeJoinSession(...models) {
        models = [this.host, ...models];

        const session = models.map(({_session}) => _session).filter(a => a)[0];
        if (!session) return;

        models.forEach(model => {
            if (model._session) {
                if (model._session != session) throw new ModelStateError(
                    `${ model } is in a different session`
                );

                return;
            }
            
            session.add(model);
        });
    }

    /**
    *   Return the remote side for this relation on the given model, if there
    *   is one. Will not return unloaded relations unless they're explicitly
    *   requested.
    */
    _findRemoteSideOn(model, ifUnloaded=false) {
        //  Determine the class of the remote side.
        //  XXX: Ugly child-class awareness.
        const HostClass = this instanceof OneSideRelationProxy ?
            ManySideRelationProxy : OneSideRelationProxy;

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

    /**
    *   Return a simpified representation of this relation proxy for use in
    *   diagnostics. 
    */
    toString() {
        return `${ this.constructor.name }<${ 
            this.sourceAttribute } -> ${ this.destinationAttribute 
        }> {\n  loaded: ${ 
            this.loaded 
        },\n  host: ${ 
            (this.host + '').replace(/\n/g, '\n  ')  
        }\n}`;
    }
}

/**
*   A relation proxy that lives on one-side models. 
*/
class OneSideRelationProxy extends RelationProxy {
    /**
    *   Find and return the described one-side relation proxy on the given
    *   model or return `null`.
    */
    static findOnModel(model, friendM, foreignKeyAttribute=null) {
        return RelationProxy._findClassedOnModel(
            OneSideRelationProxy, model, friendM, foreignKeyAttribute
        );
    }

    /**
    *   Construct and return a one-side relation proxy between the given model
    *   and referenced target, specifically using the given foreign key if it's
    *   specified. 
    */
    static fromModel(
        model, targetCollectionReference, foreignKeyAttribute, options
    ) {
        return RelationProxy._classedFromModel(
            OneSideRelationProxy, (a, b) => [a, b], model,
            targetCollectionReference, foreignKeyAttribute, options
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
    *   If the host of this relation is currently present in a loaded remote
    *   side, remove it from there.
    */
    _maybeRemoveFromRemoteSide() {
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
    *
    *   The second parameter is reserved for internal use.
    */
    set(model, _asConstruction=false) {
        //  Prepare for work by asserting this relationship is loaded, except
        //  when this is during construction of an ephemeral model, in which
        //  case this proxy has no state yet.
        if (!_asConstruction) this._assertLoaded();

        //  Ensure we actually have something to do.
        if (model === this._value) return;

        //  Remove the host from the existing remote side it belongs to if
        //  there is one.
        this._maybeRemoveFromRemoteSide();

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

            this._maybeJoinSession(model);
        }
        else {
            //  We're clearing this relation.

            //  Null out the foreign key value and the value here.
            this.host[
                this.sourceAttribute
            ] = new _SideEffectAttributeAssignment(null);
            this._value = null;
        }
    }

    /**
    *   Retrieve the model from this relationship. Synchronous if the value has
    *   already been loaded, asynchronous otherwise.
    */
    get() {
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
class ManySideRelationProxy extends RelationProxy {
    /**
    *   Find and return the described one-side relation proxy on the given
    *   model or return `null`.
    */
    static findOnModel(model, friendM, foreignKeyAttribute=null) {
        return RelationProxy._findClassedOnModel(
            ManySideRelationProxy, model, friendM, foreignKeyAttribute
        );
    }

    /**
    *   Construct and return a one-side relation proxy between the given model
    *   and referenced target, specifically using the given foreign key if it's
    *   specified. Order configuration can also be provided.
    */
    static fromModel(
        model, targetCollectionReference, foreignKeyAttribute, options
    ) {
        return RelationProxy._classedFromModel(
            ManySideRelationProxy, (a, b) => [b, a], model, 
            targetCollectionReference, foreignKeyAttribute, options
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
        this.orderComponents = resolveOrderTemplate(
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
        if (modelRemoteSide) modelRemoteSide._maybeRemoveFromRemoteSide();

        //  Set up the foreign key attribute link.
        setupForeignKeyBetween(
            model, this.host, this.sourceAttribute, this.destinationAttribute
        );

        //  Update the relationship here.
        this._value.push(model);
        this._resort();

        //  Update the remote side if there is one loaded.
        if (modelRemoteSide) modelRemoteSide._setAsSideEffect(this.host);

        this._maybeJoinSession(model);
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
        model[this.sourceAttribute] = new _SideEffectAttributeAssignment(null);
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
        if (this.loaded) return [...this._value];

        //  The value here hasn't been loaded yet, query the model list and
        //  resolve asynchronously.
        return new Promise(resolve => {
            this.host._session.query(this.friendM).where({
                [this.sourceAttribute]: this.host[this.destinationAttribute]
            }).order(this.orderComponents, false).all().then(models => {
                //  Respect ephemeral models that need to be included in this
                //  relation.
                const {ephemeralRelations} = this.host._relationalSet;
                models = [
                    ...models, 
                    ...ephemeralRelations.filter(({sourceAttribute}) => (
                        sourceAttribute == this.sourceAttribute
                    )).map(({oneSideModel}) => oneSideModel)
                ];

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
                resolve([...models]);
            });
        });
    }
}

//  Exports.
module.exports = { 
    RelationProxy, OneSideRelationProxy, ManySideRelationProxy,
    relationProxiesAttachedTo, _RelationalSet
};
