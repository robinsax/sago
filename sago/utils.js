/**
*   Miscellaneous internal utilities for general object manipulation, as well
*   as architectural components that need root-level packaging.
*/

//  XXX: This packaging.
/**
*   A sentinel wrapper-class used by relation management machinery to prevent
*   foreign key attribute proxies from performing relation management side-
*   effects upon assignment (since the assignment itself is a side-effect).
*/
class _SideEffectAttributeAssignment {
    constructor(value) {
        this.value = value;
    }
}

/**
*   Return all keys defined by the prototype of the given object, optionally
*   filtering to keys whose values are of the given class. 
*/
const getInstanceKeys = (object, OfClass=null) => (
    Object.getOwnPropertyNames(object.constructor.prototype).filter(name => (
        !OfClass || object[name] instanceof OfClass
    ))
);

/**
*   Return all values for keys defined by the prototype of the given object,
*   optionally filtering to values of the given class. 
*/
const getInstanceValues = (object, OfClass=null) => (
    getInstanceKeys(object, OfClass).map(key => object[key])
);

/**
*   Return a key, value pair object for each key defined by the prototype of
*   the given object, optionally filtering to items whose values are of the
*   given class. 
*/
const getInstanceItems = (object, OfClass=null) => (
    getInstanceKeys(object, OfClass).map(key => ({key, value: object[key]}))
);

/**
*   Define the given set of properties as non-enumerable on the given object.
*/
const defineHiddenProperties = (object, properties) => {
    const definitions = Object.keys(properties).reduce((result, property) => (
        {...result, [property]: {
            enumerable: false, writable: true, value: properties[property]
        }}
    ), {});
    Object.defineProperties(object, definitions);
};

/**
*   Return a version of the given array that contains only unqiue elements. 
*/
const uniqueElements = array => array.filter((item, i) => (
    array.indexOf(item) == i
));

//  Exports.
module.exports = { 
    _SideEffectAttributeAssignment, uniqueElements, getInstanceKeys,
    getInstanceItems, getInstanceValues, defineHiddenProperties
};
