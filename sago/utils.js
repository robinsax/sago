/**
*   Miscellaneous internal utility definitions.  
*/
const { ImmutableError, ModelStateError } = require('./errors');

//  XXX: Shouldn't exist.

const getInstanceKeys = (object, OfClass=null) => (
    Object.getOwnPropertyNames(object.constructor.prototype).filter(name => (
        !OfClass || object[name] instanceof OfClass
    ))
);

const getInstanceValues = (object, OfClass=null) => (
    getInstanceKeys(object, OfClass).map(key => object[key])
);

const getInstanceItems = (object, OfClass=null) => (
    getInstanceKeys(object, OfClass).map(key => ({key, value: object[key]}))
);

const assertModelsShareSession = (...models) => {
    const existant = models.map(model => model._session).filter(b => b)[0] || null;

    models.forEach(model => {
        //  XXX: can also happen if one model is only added but the session isn't created.
        if (model._session && model._session != existant) throw new ModelStateError(
            'One or more models are in different session'
        );
    });
}

/**
*   Define the set of attributes (really properties, but this packaging seems
*   good) as being non-enumerable on the given model. 
*/
const hideProperties = (model, ...attributes) => {
    Object.defineProperties(model, attributes.reduce((map, property) => {
        map[property] = {enumerable: false, writable: true};
        return map;
    }, {}));
};


/**
*   Write-lock an array. 
*/
const writeLockArray = (array, errorMessage) => {
    const preventMutation = () => {
        throw new ImmutableError(errorMessage);
    }

    array.push = preventMutation;
    array.pop = preventMutation;
    array.splice = preventMutation;

    return array;
};

const uniqueElements = array => array.filter((item, i) => array.indexOf(item) == i);

class SideEffectAssignment {
    constructor(value) {
        this.value = value;
    }
}

//  Exports.
module.exports = { SideEffectAssignment, uniqueElements, writeLockArray, getInstanceKeys, getInstanceItems, getInstanceValues, assertModelsShareSession, hideProperties };
