/**
*   Thrown error definitions. 
*/

/**
*   Thrown when an operation that is prohibited by an involved models state is
*   invoked. 
*/
class ModelStateError extends Error {}

/**
*   Thrown when an operation that is prohibited by the involved sessions state
*   is invoked.
*/
class SessionStateError extends Error {}

/**
*   Thrown if a schema definition error is encountered. 
*/
class SchemaError extends Error {}

/**
*   Thrown when an intentially immutable exposed object is mutated. 
*/
class ImmutableError extends Error {}

/**
*   Attribute errors are thrown when an illegal value is assigned to a model
*   attribute, or a non-existant attribute is referenced. This is the base
*   class for these types of errors.
*/
class AttributeError extends Error {}

/**
*   An aggregation of several other attribute errors. Is thrown by batch
*   model attribute updates where one or more member fails validation.
*/
class AttributeErrors extends AttributeError {
    constructor(errors) {
        super(`Multiple attribute errors: \n  ${
            Object.keys(errors).map(key => (
                `- ${ key }: ${ errors[key].constructor.name }\n    ${ 
                    (errors[key].stack + '').split('\n').join('\n    ')
                }`
            )).join(',\n  ')
        }`);
        this.errors = errors;
    }
}

/**
*   Thrown when a non-existant attribute is specified for access. This is not
*   thrown when arbitrary properties are assigned to models; that's totally
*   fine to do.
*/
class AttributeKeyError extends AttributeError {
    constructor(key) {
        super(`Invalid attribute: ${ key }`);
        this.key = key;
    }
}

/**
*   Thrown when a model attribute is assigned a value of the wrong type.
*/
class AttributeTypeError extends AttributeError {
    constructor(value, expected) {
        super(`Incorrect type of: ${ value } (expected ${ expected })`);
        this.value = value;
        this.expected = expected;
    }
}

/**
*   Thrown when a model attribute is assigned a value that fails length,
*   format, or another similar validation.
*/
class AttributeValueError extends AttributeError {
    constructor(value, error) {
        super(`Invalid value: ${ value } (${ error })`);
        this.value = value;
        this.error = error;
    }
}

//  Exports.
module.exports = { 
    ModelStateError, ImmutableError, SessionStateError, AttributeErrors, 
    AttributeError, AttributeTypeError, AttributeKeyError, 
    AttributeValueError, SchemaError
};
