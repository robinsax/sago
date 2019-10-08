/**
*   Miscellaneous internal utility definitions.  
*/
const { ImmutableError } = require('./errors');

//  XXX: Shouldn't exist.

/**
*   If the given object is a one-hot object whose key refers to an attribute in
*   the supplied attribute map, return a key, attribute type definition pair.
*   Otherwise return false.
*/
const resolveOneHotAttributeReference = (object, attributes) => {
    if (typeof object != 'object') return false;
    const keys = Object.keys(object);

    return (keys.length == 1) && (keys[0] in attributes) && (
        [keys[0], attributes[keys[0]], object[keys[0]]]
    );
}

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

//  Exports.
module.exports = { resolveOneHotAttributeReference, writeLockArray };
