/**
*   Exposed error class definitions.
*
*   ----
*   Implementation notes:
*
*   Modules can define internally-used error classes, but any error class that
*   could hypothetically be thrown out of library scope should be packaged
*   here.
*/

/**
*   Thrown when an invalid parameter is passed into library scope. 
*/
class ParameterError extends Error {}

/**
*   Thrown when a query in an invalid state is asked to emit its SQL. 
*/
class QueryError extends Error {}

/**
*   Thrown when the database library throws an error during SQL emission. 
*/
class NativeQueryError extends QueryError {
    constructor(err) {
        super(err);
        this.err = err;
    }
}

/**
*   Thrown when an operation that is prohibited by an involved models state is
*   invoked. 
*/
class ModelStateError extends Error {}

/**
*   Thrown if a schema definition error is encountered. 
*/
class SchemaError extends Error {}

/**
*   Attribute errors are thrown when an illegal value is assigned and/or
*   committed to a model attribute. This is the base class for these types of
*   errors.
*/
class AttributeError extends Error {}

/**
*   An aggregation of several other attribute errors. Is thrown by batch
*   model attribute updates where one or more members fail validation.
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
*   Thrown when a non-existant attribute is specified for assignment to a model
*   via certain interfaces. Generally arbitrary properties can be assigned to
*   models, but interfaces that expect potentially un-trusted input prefer to
*   throw this error (such as model updates from de-serialized input).
*/
class AttributeKeyError extends AttributeError {
    constructor(key) {
        super(`Invalid attribute: ${ key }`);
        this.key = key;
    }
}

/**
*   Thrown when a model attribute is assigned a value that fails length,
*   format, or another similar constraint.
*/
class AttributeValueError extends AttributeError {
    constructor(identity, value, message) {
        super();
        this.value = value;
        this.identity = identity;
        this.message = message;
        this.pureMessage = message;

        this._updateMessage();
    }

    _updateMessage() {
        this.message = `Invalid value: ${ 
            this.value
        } for attribute ${
            this.identity || '<anonymous>'
        } (${ this.message })`;
    }

    _setHostIdentity(identity) {
        this.identity = identity;

        this._updateMessage();
    }
}

/**
*   Thrown when a model attribute is assigned a value of the wrong type.
*/
class AttributeTypeError extends AttributeValueError {
    constructor(identity, value, expected) {
        super(identity, value, `expected ${ expected }`);
    }
}

/**
*   Thrown when invalid values are found on relational model attributes at
*   commit time. 
*/
class RelationalAttributeError extends AttributeValueError {
    constructor(identity) {
        super(identity, null, 'relationship never constructed');
    }
}

//  Exports.
module.exports = { 
    SchemaError, ModelStateError, AttributeError, AttributeErrors,
    AttributeTypeError, AttributeKeyError, AttributeValueError,
    RelationalAttributeError, ParameterError, QueryError, NativeQueryError
};
