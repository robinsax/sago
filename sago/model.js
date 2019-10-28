/**
*   The base model class definition. This base class provides lifecycle hook
*   method stubs, as well as several utilities.
*/
const { 
    ModelStateError, AttributeError, AttributeErrors, AttributeKeyError,
    ParameterError
} = require('./errors');
const { 
    _RelationalSet, OneSideRelationProxy, ManySideRelationProxy, RelationProxy
} = require('./relations');
const { 
    _SideEffectAttributeAssignment, defineHiddenProperties 
} = require('./utils');

/**
*   The base model class. Implements lifecycle hook method stubs, as well as
*   several utilities. Subclasses cannot override the constructor. Note that
*   models must inherit from this class _and_ register with their parent
*   database.
*/
class Model {
    /**
    *   Create a model, optionally copying attributes from a given object. The
    *   given object should contain only attributes in the schema of this
    *   model and initial values of one-side relation proxies.
    * 
    *   This constructor cannot be overridden as it is used for reconstruction,
    *   the `modelDidConstruct()` lifecycle hook should be used instead.
    *
    *   The second parameter is reserved for internal use.
    */
    constructor(sourceObject=null, _session=null) {
        const {_schema: schema} = this.constructor;
    
        //  The schema comprehension process will instantiate models to read
        //  their instance fields. If there is no schema assigned to this model
        //  class yet, we're in that state and don't need to set up anything.
        if (schema) {
            //  Remove possible definitions.
            delete this.schema;
            delete this.collection;

            //  Set hidden attributes.
            defineHiddenProperties(this, {
                //  Whether or not attribute proxies should record changes.
                _dirtying: true,
                //  A container for attribute proxies to track changes within
                //  a transaction.
                _dirty: {},
                //  A set of relation-management metadata for this model.
                _relationalSet: new _RelationalSet(this),
                //  The session to which this model belongs, provided if this
                //  is a reconstruction.
                _session,
                //  Whether this model is row bound. Initialized at true if
                //  this is a reconstruction.
                _bound: !!_session
            });
            //  Allow the schema to set up the relation proxies for this model.
            schema._attachAttributeProxies(this);
            
            //  Maybe copy attributes from the supplied source object.
            if (sourceObject) {
                //  Assert the parameter is of the correct type.
                if (typeof sourceObject != 'object') throw new ParameterError(
                    'Bad source object'
                );
                
                //  Iterate source object, assigning appropriately.
                Object.keys(sourceObject).forEach(attribute => {
                    if (attribute in schema.attributeIdentities) {
                        //  Simple attributes; assign directly.
                        this[attribute] = new _SideEffectAttributeAssignment(
                            sourceObject[attribute]
                        );
                    }
                    else if (this[attribute] instanceof OneSideRelationProxy) {
                        //  Initial value for a one-side relation proxy, use
                        //  the setter.
                        this[attribute].set(sourceObject[attribute], !_session);
                    }
                    else throw new AttributeKeyError(attribute);
                });
            }

            //  Invoke lifecycle hook so subclasses can handle construction.
            this.modelDidConstruct();
        }
    }

    /**
    *   Update the attributes of this model using the given update object. If
    *   `serialized` is `true`, the values of the update object will be
    *   de-serialized before assignment. If any errors are encountered during
    *   this process, a cummulative `AttributeErrors` will be thrown.
    */
    update(updateObject, serialized=false) {
        //  Create an error aggregator.
        const {_schema: schema} = this.constructor, errors = {};
        
        //  Iterate update object, assigning with safety.
        Object.keys(updateObject).forEach(attribute => {
            //  Retrieve the attribute identity for this attribute key.
            const identity = schema.attributeIdentities[attribute];

            //  Ensure this attribute exists.
            if (!identity) {
                errors[attribute] = new AttributeKeyError(attribute);
                return;
            }

            //  Take the value and deserialize if nessesary.
            let value = updateObject[attribute];
            if (serialized) {
                //  Deserialize the given value using it's correct type, with
                //  error collection.
                try {
                    value = identity.type.deserialize(value);
                }
                catch (err) {
                    if (!(err instanceof AttributeError)) throw err;
                   
                    //  Save the error.
                    errors[attribute] = err;
                    return;
                }
            }

            //  Perform assignment with safety for value or type violations.
            try {
                this[attribute] = value;
            }
            catch (err) {
                if (!(err instanceof AttributeError)) throw err;

                //  Save the error.
                errors[attribute] = err;
                return;
            }
        });

        //  If errors were encounted, throw a cummulative error.
        if (Object.keys(errors).length) throw new AttributeErrors(errors);
    }

    /**
    *   Serialize this model, with support for walking relation proxies. Can be
    *   invoked asynchronously to allow walking of unloaded relation proxies.
    * 
    *   By default will return an object containing the set of attributes in
    *   this models schema. The value of each attribute will be serialized, but
    *   the return value of this function will still be an object.
    * 
    *   The provided options can include:
    * 
    *   ~ `include`, a list of additional properties to include in the result. 
    *     If relation proxy properties are specified, the array element can
    *     instead be an array where the second element is a nested set of
    *     options to pass to `serialize()` on the child model. (e.g. `
    *         order.serialize({include: [['products', {exclude: ['price']}]]})
    *     `)
    *   ~ `exclude`, a list of properties to omit from the result.
    *   ~ `async`, whether to return a `Promise`. Required if an `include`
    *     list at any depth contains unloaded relation proxies.
    *   ~ `string`, whether or not to stringify the return value.
    */
    serialize({
        async: isAsync=false,
        string: returnString=false,
        include=[],
        exclude=[], 
        ...otherOptions
    }={}) {
        const {_schema: schema} = this.constructor;

        //  Validate options set.
        if (Object.keys(otherOptions).length) throw new ParameterError(
            `Invalid options: ${ otherOptions }`
        );

        //  Define helpers.
        /**
        *   Perform a final transformation on the result object to ensure it
        *   respects all options.
        */
        const transformReturnValue = result => {
            //  Ensure we're returning a promise if running asynchronously.
            if (isAsync && !(result instanceof Promise)) {
                const trueResult = result;
                result = new Promise(resolve => resolve(trueResult));
            }

            //  Honour stringify option.
            if (returnString) {
                if (result instanceof Promise) return result.then(result => (
                    JSON.stringify(result)
                ));
                else return JSON.stringify(result);
            }

            return result;
        };
        /**
        *   Serialize the member(s) of a relation proxy. 
        */
        const serializeAcrossRelation = (
            value, deepOptions={}, forceSync=false
        ) => {
            const oneChild = !(value instanceof Array),
                stepAsync = !forceSync && isAsync;

            if (oneChild) {
                if (!value) return null;
                else value = [value];
            }

            const result = value.map(model => (
                model.serialize({...deepOptions, async: stepAsync})
            ));

            if (oneChild) return result[0];
            if (stepAsync) return Promise.all(result);
            return result;
        }

        //  Collect attribute values not found in the exclude list with
        //  serialization.
        const result = Object.values(schema.attributeIdentities)
            .reduce((result, identity) => {
                if (exclude.indexOf(identity.attribute) >= 0) return result;

                //  Resolve the type from the identity and serialize the value
                //  with it.
                result[identity.attribute] = identity.type.serialize(
                    this[identity.attribute]
                );
                return result;
            }, {});

        //  Iterate the include list, collecting a list of Promises if we
        //  encounter unloaded relations and are running asynchronously.
        const asyncWork = include.map(key => {
            //  Comprehend and assert the inclusion key and options are valid.
            let options = null;
            if (key instanceof Array) [key, options] = key;
            if (typeof key != 'string') throw new ParameterError(
                `Invalid include key ${ key }`
            );
            if (typeof options != 'object') throw new ParameterError(
                `Invalid deep options ${ options }`
            );

            //  Read the value from this model.
            let value = this[key];

            //  If the value isn't a relation proxy we just assign it to the
            //  result.
            if (!(value instanceof RelationProxy)) {
                //  Assert options weren't supplied.
                if (options) throw new ParameterError(
                    `Deep options supplied for simple include ${ key }`
                )

                result[key] = value;
                return false;
            }

            if (value.loaded) {
                //  No asynchronous work required, retrieve the relation proxy
                //  value and serialize synchronously.
                result[key] = serializeAcrossRelation(
                    value.get(), options, true
                );
            }
            else if (isAsync) {
                //  We can support asynchronous work, load the relation proxy
                //  and defer the serialization.
                return value.get().then(resolved => (
                    serializeAcrossRelation(resolved, options)
                )).then(resultValue => {
                    result[key] = resultValue;
                });
            }
            //  Otherwise, we don't support asynchronous work and this is
            //  impossible.
            else throw new ModelStateError(
                `Unloaded relation in synchronous call to serialize()`
            );
        }).filter(a => a);

        //  Return synchronously or wait for all asynchronous work to complete.
        if (!isAsync) return transformReturnValue(result);
        else return Promise.all(asyncWork).then(() => (
            transformReturnValue(result)
        ));
    }

    /**
    *   Return a one-side relation proxy. If there are multiple foreign keys
    *   that make this relation ambiguous, the attribute key of the one to use
    *   must be specified in the options object.
    *  
    *   The destination reference can be a model class or collection name.
    */
    oneRelation(destinationReference, options={}) {
        return this._relationalSet.resolveRelationProxy(
            OneSideRelationProxy, destinationReference, options
        );
    }

    /**
    *   Return a many-side relation proxy. If there are multiple foreign keys
    *   that make this relation ambiguous, the attribute key of the one to use
    *   must be specified in the options object (it will exist on the
    *   one-side). The options object may also contain `order`, a query
    *   compatable ordering.
    *   
    *   The destination reference can be a model class or collection name.
    */
    manyRelation(destinationReference, options={}) {
        return this._relationalSet.resolveRelationProxy(
            ManySideRelationProxy, destinationReference, options
        );
    }

    /**
    *   A model-level attribute lifecycle hook. Must return the value to set.
    *   Note that this method is invoked before type assertion, so the
    *   assignment isn't guarenteed to succeed.
    */
	modelAttributeWillSet(attribute, value) { return value; }
    
    /**
    *   A model lifecycle stub called after construction and reconstruction. 
    */
    modelDidConstruct() {}

    /**
    *   A model lifecycle stub called after reconstruction. 
    */
    modelDidReconstruct() {}
    
    /**
    *   A model lifecycle stub called after a from-database refresh. These only
    *   occur when the model is explicity reloaded by another query, or when
    *   they are first written into the database after construction.
    */
    modelDidHydrate() {}

    /**
    *   A model lifecycle stub called before a database write.
    */
	modelWillStore() {}

    /**
    *   A model lifecycle stub called after a database sync. 
    */
    modelDidStore() {}

    /**
    *   Return a string representation of this model with resolved attribute
    *   getters.
    */
    toString() {
        const {name, _schema: schema} = this.constructor;
        return `${ name }<Model> {\n  ${
            Object.keys(schema.attributeIdentities).map(attribute => (
                `${ attribute }: ${ this[attribute] }`
            )).join(',\n  ')
        }\n}`;
    }
}

//  Exports.
module.exports = { Model };
