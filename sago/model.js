/**
*   The base model class definition. All models must subclass from the class
*   defined here or risk undefined behaviour.
*/
const { 
    AttributeError, AttributeErrors, AttributeKeyError, SchemaError 
} = require('./errors');
const { 
    OneRelationProxy, ManyRelationProxy, RelationProxy 
} = require('./relations');
const { attachAttributeProxies, hideAttributes } = require('./attributes');

/**
*   Generate if nessesary and return an relation proxy of the given class,
*   with on-model caching.
*/
const resolveRelationProxyWithCache = (
    model, RelationProxyClass, destinationReference, options={}
) => {
    //  Unpack options.
    const {fk: fkAttribute, order} = options;

    //  Resolve the cache key from the collection or model class name of the
    //  destination plus the foreign key attribute key.
    const cacheKey = `
        ${ typeof destinationReference == 'function' ? 
            destinationReference.name : destinationReference 
        }_${ fkAttribute }
    `;

    //  Check the on-model cache and populate if nessesary.
    if (!model._relationCache[cacheKey]) {
        model._relationCache[cacheKey] = RelationProxyClass.fromModel(
            model, destinationReference, fkAttribute, order
        );
    }
    //  Return the relation proxy.
    return model._relationCache[cacheKey];
}

/**
*   Register a relationship-building foreign key assignment with an ephemeral
*   model. This would be more logically implemented as a method of `Model`, but
*   we don't want to expose it.
*
*   The relationship proxy treats this operation as eqivalent to actually
*   forming the relationship.
*/
const registerRelationshipIntentOnEphemeral = (
    host, target, sourceAttribute, destinationAttribute
) => {
    //  Sanity check; assert the both models are currently ephemeral.
    //  XXX: It is theoretically possible to allow this if only the host is
    //       ephemeral, but it would require the corresponding
    //       `ManyRelationProxy` to be put into a state that doesn't reflect
    //       the true state of the data model (consider after coffee).
    if (host._bound || target._bound) throw new Error(
        'A relationship proxy attempted to register an ephemeral relation with'
        + ' a row-bound model (this is a bug in sago).'
    );

    if (host._bindIntents.filter(i => (
        target == i.target && sourceAttribute == i.sourceAttribute &&
        destinationAttribute == i.destinationAttribute
    )).length > 0) return;

    //  Register the coupling to be performed on bind. This will involve first
    //  creating the target model, then assigning it's ID to the foreign key
    //  attribute of the host.
    host._bindIntents.push({target, sourceAttribute, destinationAttribute});
}

/**
*   The base model class implements a constructor which should not be
*   overridden, placeholder lifecycle hooks, helpers for creating relation
*   proxies, and methods for performing serialization, update assignment, and 
*   deep de-serialzation.
*
*   The constructor of this class should not be overwritten as there is no
*   language support for back-door reconstruction. The one defined here accepts
*   an object which it directly copies. To assign serialized data to a model,
*   use `update(data, true)`.
*
*   All model subclasses must implement a static method `schema()` which
*   returns either an array `[<collection_name>, <schema_template>]`, or the
*   schema template directly if the collection name is going to be declared
*   later (e.g. by class decorator with `Database.collection()`).
*
*   Schema templates are maps whose keys are attribute names and values are
*   either a type reference string or array with `[<type_reference>, 
*   <options_object>]`. See `types.js` for the list of stock types and their
*   reference strings.
*/
class Model {
    /**
    *   Create a model, optionally copying attributes from a given object. The
    *   given object should contain only attributes in the schema of this
    *   model, extraneous keys will result in an `AttributeError`.
    */
    constructor(sourceObject=null, reconstruction=false) {
        const {_schema} = this.constructor;
        //  The schema parser will instantiate models to read their class
        //  fields. If there is no schema assigned to this model class yet,
        //  we're in that state and don't need to construct anything.
        if (_schema) {
            //  Set up model machinery.
            hideAttributes(this, ...[
                '_session', '_relationCache', '_setAttributeProxyStates',
                '_dirty', '_bound', '_bindIntents'
            ]);
            this._setAttributeProxyStates = attachAttributeProxies(
                this, _schema
            );
            this._bound = reconstruction;
            this._dirty = {};
            this._session = null;
            this._relationCache = {};
            this._bindIntents = reconstruction ? null : [];
            
            //  Maybe copy attributes from the supplied source object.
            if (sourceObject) {
                if (typeof sourceObject != 'object') {
                    throw new Error('Bad source object');
                }
                
                Object.keys(sourceObject).forEach(key => {
                    if (key in _schema.attributes) {
                        //  Assign attributes.
                        this[key] = sourceObject[key];
                    }
                    else if (this[key] instanceof OneRelationProxy) {
                        //  Assign one-side relation proxies if it's able to
                        //  happen synchronously.
                        const result = this[key].set(sourceObject[key]);
                        if (result instanceof Promise) {
                            throw new ModelStateError(
                                'Cannot join relationship synchronously'
                            );
                        }
                    }
                    else throw new AttributeKeyError(key);
                });
            }
            this.modelDidConstruct();

            //  Enable dirtying by attribute proxies.
            this._setAttributeProxyStates({dirtying: true});
        }
    }

    /**
    *   Update the attributes of this model using the given update object. If
    *   `serialized` is `true`, the values of the update object will be
    *   de-serialized before assignment. If any errors are encountered during
    *   that process, a cummulative `AttributeErrors` will be thrown.
    */
    update(updateObject, serialized=false) {
        const {_schema: {attributes}} = this.constructor;

        const errors = {};
        Object.keys(updateObject).forEach(key => {
            //  Ensure this is a valid attribute key.
            if (!(key in attributes)) {
                errors.push(new AttributeKeyError(key));
                return;
            }

            let value = updateObj[key];
            if (serialized) {
                //  Deserialize the given value using it's correct type with
                //  error collection.
                try {
                    value = attributes[key].deserialize(value);
                }
                catch (ex) {
                    if (!(ex instanceof AttributeError)) throw ex;
                    
                    errors.push(ex);
                    return;
                }
            }

            this[key] = value;
        });

        //  If errors were encounted, throw a cummulative container.
        if (Object.keys(errors).length) throw new AttributeErrors(errors);
    }

    /**
    *   Serialize this model. When used asynchronously, can serialize
    *   constituent relations to an arbitrary depth (but not cyclically, duh).
    *   Overriding this method and calling `super` is an encouraged pattern.
    *   
    *   The provided options object can specify `include` and `exclude` lists.
    *   If `RelationProxy`s are found in the include list, the `async` option
    *   must also be specified and this method will return a `Promise`.
    *
    *   Keys in the include list that correspond to a relation proxy can be
    *   provided as arrays with `['<attribute_name>', <deep_options>]`, where
    *   deep options is the options object passed to the models of that
    *   relationship proxy. This can be nested arbitrarily. The async option is
    *   provided implicitly.
    */
    serialize(options={}) {
        const {_schema: {attributes}} = this.constructor;

        //  Create a return value helper.
        const maybeStringify = result => {
            if (options.string) return JSON.stringify(result);
            else return result;
        }

        //  Resolve exclude list.
        const {include} = options, exclude = options.exclude || [];

        //  Collect attribute values not found in the exclude list, with
        //  serialization.
        const result = Object.keys(attributes).reduce((result, key) => {
            if (exclude.indexOf(key) >= 0) return result;

            result[key] = attributes[key].serialize(this[key]);
            return result;
        }, {});

        //  If no include list was specified, we're done.
        if (!include) {
            if (options.async) return new Promise(resolve => resolve(result));
            else return maybeStringify(result);
        }

        //  Iterate the include list synchronously if async wasn't specified.
        //  XXX: We could add support for synchronous serialization with
        //       `RelationProxy`s if they were previously loaded.
        if (!options.async) {
            for (let i = 0; i < include.length; i++) {
                const key = include[i];
                let value = this[key];
            
                if (value instanceof RelationProxy) throw new Error();

                result[key] = value;
            }

            return maybeStringify(result);
        }

        //  Iterate the include list asynchronously. This was hard to write.
        return Promise.all(include.map(includeKey => {
            let deepOptions = {};
            //  Recognize deep options in the include list.
            if (includeKey instanceof Array) {
                [includeKey, deepOptions] = includeKey;
            }
            //  Resolve the value.
            const value = this[includeKey]

            //  Return simple promises for non-relation proxy properties.
            if (!(value instanceof RelationProxy)) {
                return new Promise(resolve => resolve(value));
            }
            
            const many = value instanceof ManyRelationProxy;
            return new Promise(resolve => {
                //  We first resolve the value if its accessor is still
                //  asynchronous.

                //  Relation proxy accessors are synchronous if the relation was
                //  previously loaded.
                const generator = value.get();
                if (!(generator instanceof Promise)) resolve(generator);
                else generator.then(value => resolve(value));
            }).then(value => {
                //  We then allow the one or many related models to serialize
                //  themselves, resolving with a list of key, serialized
                //  relationship constituent pairs.

                if (many) {
                    //  Value is a list of models.
                    return Promise.all(value.map(model => (
                        new Promise(resolve => {
                            model.serialize({
                                ...deepOptions, async: true
                            }).then(serialized => {
                                resolve(serialized);
                            });
                        })
                    ))).then(list => [includeKey, list]);
                }
                else {
                    //  Value is a single model.
                    return new Promise(resolve => {
                        value.serialize({
                            ...deepOptions, async: true
                        }).then(serialized => {
                            resolve([includeKey, serialized]);
                        });
                    });
                }
            });
        })).then(collectedIncludes => {
            //  Finally, merge the resulting key, value pairs into our existing
            //  result object and resolve the top level of this promise swamp.
            collectedIncludes.forEach(([resolvedKey, resolvedValue]) => {
                result[resolvedKey] = resolvedValue;
            });
            
            return maybeStringify(result);
        });
    }

    /**
    *   Return a one-side relation proxy. If there are multiple foreign keys
    *   that make this relation ambiguous, the key of the one to use must be
    *   specified in the options object.
    *  
    *   The destination reference can be a model class or collection name.
    */
    oneRelation(destinationReference, options={}) {
        return resolveRelationProxyWithCache(
            this, OneRelationProxy, destinationReference, options
        );
    }

    /**
    *   Return a many-side relation proxy. If there are multiple foreign keys
    *   that make this relation ambiguous, the key of the one to use must be
    *   specified in the options object (it will exist on the destination
    *   side). The options object may also contain an `order` that contains a
    *   one-hot object whose key is the attribute by which to order (on the
    *   destination side), and value is `asc` or `desc`.
    *  
    *   The destination reference can be a model class or collection name.
    */
    manyRelation(destinationReference, options={}) {
        return resolveRelationProxyWithCache(
            this, ManyRelationProxy, destinationReference, options
        );
    }

    /**
    *   A model-level attribute lifecycle hook. Must return the value to set.
    *   Note that this method is invoked before type assertion, so the
    *   assignment isn't guarenteed to succeed.
    */
	attributeWillSet(attribute, value) { return value; }
    
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
    modelDidRefresh() {}

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
        const {name, _schema: {attributes}} = this.constructor;
        return `${ name }<Model> {\n  ${
            Object.keys(attributes).map(a => `${a}: ${this[a]}`).join(',\n  ')
        }\n}`;
    }
}

//  Exports.
module.exports = { 
    Model, registerRelationshipIntentOnEphemeral 
};
