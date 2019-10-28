/**
*   Attribute proxy machinery. Attribute proxies handle the assignment and
*   retrieval of model attribute values by:
*
*   ~ Tracking attribute changes to allow automatic update emissions and
*     rollbacks.
*   ~ Enforcing attribute types at assignment time.
*   ~ Enforcing attribute format at assignment time if applicable.
*   ~ Invoking relational side effects during assignment when proxying a
*     foreign key.
*
*   ----
*   Implementation notes:
*
*   The term attribute is used in place of property to differentiate between
*   ephemeral and column-bound properties. Variables named "...attribute"
*   should contain the property key of an attribute. Variables named
*   "...identity" should contain actual `AttributeIdentity`s.
*/
const { AttributeValueError } = require('./errors');
const { _SideEffectAttributeAssignment } = require('./utils');

/**
*   Attribute identities are an encapsulation of a model attributes schema.
*   They are aware of their parent model class, type, and property key.
*
*   The schema comprehension machinery is responsible for constructing these
*   identities, as well as attaching them under their respective keys to their
*   model class for convenience.
*/
class AttributeIdentity {
    constructor(M, attribute, type) {
        this.M = M;
        this.type = type;
        this.attribute = attribute;
    }

    /**
    *   Allow the type to validate the given value or die, with host attribute
    *   identity provided in any thrown error diagnostics.
    * 
    *   Since types aren't host attribute aware, if strict type validation is
    *   occurring within library scope, this method should always be preferred
    *   to the type implementation.
    */
    contextAwareValidateOrDie(value) {
        try {
            this.type.validateOrDie(value);
        }
        catch (err) {
            if (!(err instanceof AttributeValueError)) throw err;

            //  Update this attribute value error with host attribute identity
            //  awareness.
            err._setHostIdentity(this);
            throw err;
        }
    }

    /**
    *   Return a string representation of this identity for use in diagnostics. 
    */
    toString() {
        return `AttributeIdentity<${ this.M.name }.${ 
            this.attribute 
        }> {\n  type: ${
            this.type.constructor.name
        }\n}`;
    }
}

/**
*   Attribute proxies manage model attribute value assignment and retrieval as
*   described in the module documentation. They do not bind themselves as a
*   side-effect of construction, this must be done explicitly.
*
*   They are aware of their parent model, as well as the identity of the
*   attribute they're proxying.
*
*   The model initialization machinery is responsible for constructing and
*   binding these proxies.
*/
class AttributeProxy {

    constructor(model, attributeIdentity) {
        this.model = model;
        this.attributeIdentity = attributeIdentity;

        //  Allow the type definition to initialize the value of the proxied
        //  attribute.
        this._value = this.type._generateInitialValue();
    }

    //  Define short-hand accessors.
    get parentSchema() { return this.model.constructor._schema; }
    get attribute() { return this.attributeIdentity.attribute; }
    get type() { return this.attributeIdentity.type; }

    /**
    *   Simply retrieve the attribute value. 
    */
    get() {
        return this._value;
    }

    /**
    *   Assign a new value to this attribute, with the management discussed in
    *   the module documentation.
    */
    set(value) {
        //  If a relationship proxy is assigning a foreign key value as a side-
        //  effect of relationship construction, we skip performing any
        //  relation management here.
        const asSideEffect = value instanceof _SideEffectAttributeAssignment;
        if (asSideEffect) value = value.value;

        //  Allow the model implementation to impact the eventual value.
        value = this.model.modelAttributeWillSet(this.attribute, value);

        //  Ensure the value is changing.
        if (value === this._value) return value;

        //  Assert the type for this attribute validates the new value. Note
        //  that null values are allowed even if the attribute type is non-
        //  nullable. Attribute existance is enforced at session commit time.
        if (value !== null) this.type.validateOrDie(value);

        //  If this model is currently tracking attribute dirtying (i.e. isn't
        //  constructing or hydrating), track this change. If a change has
        //  already been recorded, we don't override that previous value.
        if (this.model._dirtying && !(this.attribute in this.model._dirty)) {
            this.model._dirty[this.attribute] = this._value;
        }

        //  If we don't need to perform any relation management side effects,
        //  we're done.
        if (!this.type.isForeignKey || asSideEffect) {
            return this._value = value;
        }

        //  This is a foreign key, we may need to apply side effects on loaded
        //  relations.
        //  XXX: Not an ideal import...
        const { OneSideRelationProxy } = require('./relations');

        //  Discover the corresponding relation proxy for this attribute.
        const destinationIdentity = this.type.foreignKeyDestinationIdentity,
            oneSideProxy = OneSideRelationProxy.findOnModel(
                this.model, destinationIdentity.M, this.attribute
            );

        //  We only need to manage the relation proxies if they're loaded. This
        //  applicability check relies on the relation proxy machinery's
        //  invariant that many-sides are never loaded without their
        //  corresponding one-sides being loaded too.
        if (oneSideProxy && oneSideProxy.loaded) {
            if (value) {
                //  We are assigning a non-null value.

                //  Search for the many-side model among models loaded by the
                //  session containing the host model of these proxies.
                const session = this.model._session;
                //  XXX: In what case would the session not exist here? Add
                //  handling for that case.
                //  XXX: Handle the case that there are somehow multiple loaded
                //  models with the destination attribute value (either by
                //  adding an invariant or just dieing).
                const manySideModel = session._allModels.filter(model => (
                    model[destinationIdentity.attribute] == value
                ))[0] || null;

                if (manySideModel) {
                    //  The new relation target is loaded, defer to the
                    //  relation proxy to perform the update. Note this will
                    //  including assigning the value of this attribute as a
                    //  side-effect, so the value here will be updated after
                    //  that operation.
                    oneSideProxy.set(manySideModel);
                    return this._value;
                }
                else {
                    //  The new relation target is not loaded, force the
                    //  one-side proxy to enter an unloaded state and remove
                    //  the host model these proxies from the existing remote
                    //  many-side if there is one. The session is now
                    //  responsible for ensuring the assigned value has an
                    //  existant destination, meaning an insane value won't
                    //  cause a throw until session commit time.
                    oneSideProxy._maybeRemoveFromRemoteSide();
                    oneSideProxy._forceUnload();
                }
            }
            else oneSideProxy.set(null);
        }
    }

    /**
    *   Attach this attribute proxy to it's parent model. Must be called after
    *   construction.
    */
    bind() {
        //  Define this as the property descriptor for the proxied attribute on
        //  the parent model.
        Object.defineProperty(this.model, this.attribute, {
            enumerable: true,
            get: this.get.bind(this),
            set: this.set.bind(this)
        });
    }
}

//  Exports.
module.exports = { AttributeIdentity, AttributeProxy };
