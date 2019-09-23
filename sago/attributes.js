/**
*   Attribute proxy machinery and other model attribute utilities. 
*/
const { ModelStateError } = require('./errors');

/**
*   Attribute proxies define themselves onto models and handle type enforcement
*   and relational side-effects for their proxied attribute.
*/
class AttributeProxy {

    constructor(model, attribute) {
        this.model = model;
        this.attribute = attribute;

        //  Initialize.
        // XXX: Doing this here causes an extra update emission.
        this._value = this.type.getInitialValue();
        //  Define variable state attributes.
        this.dirtying = false;
        this.writable = true;
    }

    get type() { 
        return this.model.constructor._schema.attributes[this.attribute]; 
    }

    /**
    *   Update the dirty-tracking and write-locking states of this attribute
    *   proxy.
    */
    updateState({dirtying, writable}) {
        if (dirtying !== undefined) this.dirtying = dirtying;
        if (writable !== undefined) this.writable = writable;
    }

    //  Implement the property definition schema.
    get() { return this._value; }
    set(newValue) {
        //  Ensure the parent model hasn't been write-locked after a delete
        //  operation.
        if (!this.writable) throw new ModelStateError('Model deleted');

        //  Allow the model lifecycle to impact attribute value. Note this
        //  lifecycle method being invoked doesn't nessesarily mean the 
        //  assignment will complete successfully.
        newValue = this.model.attributeWillSet(this.attribute, newValue);

        //  Ensure the type for this attributes validates the new value. Note
        //  we allow null values even if the attribute type definition isn't
        //  nullable. This is nessesary to allow coupling and developer will to
        //  live.
        if (newValue !== null) this.type.validateOrDie(newValue);
        //  If the value isn't actually changing, we don't need to do anything.
        if (newValue === this._value) return newValue;

        //  If the session doesn't have the parent model in a weird state to
        //  allow reconstruction or refresh, and this attribute hasn't been
        //  changed from it's last known in-DB value, update the dirty map.
        if (this.dirtying && !(this.attribute in this.model._dirty)) {
            this.model._dirty[this.attribute] = this._value;
        }

        //  TODO: Relational side-effects.
        
        //  Update the value and return.
        return this._value = newValue;
    }

    /**
    *   Attach this attribute proxy to it's parent model. Called during
    *   construction. 
    */
    bind() {
        //  Bind methods to this class.
        this.get = this.get.bind(this);
        this.set = this.set.bind(this);

        //  Define this as the property descriptor for the proxied attribute on
        //  the parent model.
        Object.defineProperty(this.model, this.attribute, {
            enumerable: false,
            get: this.get,
            set: this.set
        });
    }
}

/**
*   Attach an attribute proxy to the given model for each attribute in the
*   given schema and return a callable that can be used to control their
*   combined states. 
*/
const attachAttributeProxies = (model, schema) => {
    const proxySet = [];
    
    Object.keys(schema.attributes).forEach(attribute => {
        const proxy = new AttributeProxy(model, attribute);
        proxy.bind();
        proxySet.push(proxy);
    });

    return proxyStateUpdate => proxySet.forEach(proxy => {
        proxy.updateState(proxyStateUpdate)
    });
}

/**
*   Define the set of attributes (really properties, but this packaging seems
*   good) as being non-enumerable on the given model. 
*/
const hideAttributes = (model, ...attributes) => {
    Object.defineProperties(model, attributes.reduce((map, property) => {
        map[property] = {enumerable: false, writable: true};
        return map;
    }, {}));
};

//  Exports.
module.exports = { attachAttributeProxies, hideAttributes };
