/**
*   Model and type set aggregations and top-level schema comprehension
*   machinery.
*/
const { Pool } = require('pg');

const { DEFAULT_TYPE_ALIAS_MAP, DEFAULT_TYPE_MAP } = require('./types');
const { SchemaError } = require('./errors');
const { Session } = require('./session');
const { Model } = require('./model');
const { AttributeProxy, AttributeIdentity } = require('./attributes');

//  A master lookup of all defined databases.
const _databases = {};
//  The default database schema version if none is specified.
const DEFAULT_SCHEMA_VERSION = 'v0.0.1';

/**
*   Transform the schema template provided for the given model class into an
*   attribute key, attribute identity map. The existance of the schema template
*   and collection names must be asserted first by the caller. 
*/
const attributeIdentitiesForModelClass = (database, M) => (
    Object.keys(M.schema).reduce((resultIdentities, attribute) => {
        //  Comprehend the value for this attribute in the template, which
        //  should be either a string containing a type reference, or a string
        //  type reference, options object pair. Supported options differ for
        //  each type.
        const templateValue = M.schema[attribute];
        let typeReference = templateValue, options = {};
        if (templateValue instanceof Array) {
            [typeReference, options] = templateValue;
        }

        //  Resolve the type using the parent database.
        const type = database._typeReferenceToType(typeReference, options);

        //  Extend the identity map.
        resultIdentities[attribute] = new AttributeIdentity(M, attribute, type);
        return resultIdentities;
    }, {})
);

/**
*   Model schemas are comprehensions of the declared schema for a model class.
*   They are attached to model classes as `_schema`.
*/
class ModelSchema {
    /**
    *   Construct a model schema from the schema template and collection name
    *   of the given model class using the given database. Those components
    *   must be asserted to exist by the caller.
    */
    static _fromModelClass(database, M) {
        const {collection} = M;

        //  Comprehend the schema template as an attribute key, identity map.
        const identities = attributeIdentitiesForModelClass(database, M);

        //  Find the primary key and assert there is exactly one.
        const primaryKeys = Object.values(identities).filter(identity => (
            identity.type.isPrimaryKey
        ));
        if (primaryKeys.length != 1) throw new SchemaError(
            `Wrong number of primary keys for ${ collection }`
        );

        //  Return the resultant model schema.
        return new ModelSchema(
            database, collection, identities, primaryKeys[0]
        );
    }

    /**
    *   Construct a model schema. Reserved for use by `_fromModelClass()`. 
    */
    constructor(database, collection, attributeIdentities, primaryKey) {
        //  A parent database reference.
        this.database = database;
        //  The corresponding collection name for the model class.
        this.collection = collection;
        //  The per-attribute schema comprehension as an attribute key,
        //  attribute identity map.
        this.attributeIdentities = attributeIdentities;
        //  The attribute identity of the primary key of this model class.
        this.primaryKey = primaryKey;
    }

    /**
    *   Attach an attribute proxy to the given model for each attribute in this
    *   schema.
    */
    _attachAttributeProxies(model) {
        Object.values(this.attributeIdentities).forEach(identity => {
            //  Note we don't need to store a reference to this proxy because
            //  binding causes the property definition to contain references to
            //  it.
            (new AttributeProxy(model, identity)).bind();
        });
    }

    _attachAttributeIdentities(M) {
        Object.values(this.attributeIdentities).forEach(identity => {
            try {
                M[identity.attribute] = identity;
            }
            catch (err) {
                //  Some properties can't be overridden (e.g. name).
            }
        });

        M.attributes = this.attributeIdentities;
    }

    //  TODO: Wtf?
    _ownAttributeReferenceToIdentity(reference) {
        if (reference instanceof AttributeIdentity) {
            if (reference.M._schema != this) throw new SchemaError(
                `Attribute ${ reference } doesn't belong to ${ this }`
            );

            return reference;
        }

        if (typeof reference != 'string') throw new SchemaError(
            `Invalid attribute reference string ${ reference }`
        );

        const identity = this.database._attributeReferenceToIdentity(
            [this.collection, reference].join('.')
        );
        if (identity.M._schema != this) throw new SchemaError(
            `Attribute ${ identity } doesn't belong to ${ this }`
        );

        return identity;
    }

    /**
    *   Return a string representation of this model schema for use in
    *   diagnostics.
    */
    toString() { return `ModelSchema<${ this.collection }> {}`; }
}

/**
*   Databases encapsulate sets of models and types, and act as session
*   factories. Model classes can either be provided during construction or
*   registered with an existing database.
*/
class Database {
    /**
    *   Construct a new database. This constructor should only be used
    *   internally; the root export of this library provides external access.
    *  
    *   Options can include:
    *
    *   ~ `pg`; direct configuration for `node-postgres`.
    *   ~ `types`; A type reference string, callable map where each callable
    *     returns an instance of an attribute type.
    *   ~ `typeAliases`; a type reference string, type reference string map to
    *     allow short-hand type references.
    *   ~ `models`; A list of model classes to register in this database. Note
    *     models can also be registered later with `register()`, or decorated
    *     with `collection()`.
    *   ~ `version`; A version tracker for migrations.
    */
    constructor(name, options={}) {
        this.name = name;
        this.version = options.version || DEFAULT_SCHEMA_VERSION;
        
        //  Create a connection pool into the corresponding PostgreSQL
        //  database.
        this.pool = new Pool({...(options.pg || {}), database: this.name});

        //  Resolve type and type alias maps.
        this.types = {...DEFAULT_TYPE_MAP, ...(options.types || {})};
        this.typeAliases = {
            ...DEFAULT_TYPE_ALIAS_MAP, ...(options.typeAliases || {})
        };

        //  Create the model class registry and add all initially provided
        //  model classes.
        this.models = {};
        if (options.models) options.models.forEach(M => (
            this._registerModel(M)
        ));

        //  Bind the declarative, decorator-based model registrar.
        this.collection = this.collection.bind(this);

        //  Register this database in the global lookup.
        _databases[this.name] = this;
    }
    
    /**
    *   Return a new attribute type constructed from the given type reference
    *   string and options object.
    */
    _typeReferenceToType(typeReference, options={}) {
        //  Maybe follow an alias.
        if (typeReference in this.typeAliases) {
            typeReference = this.typeAliases[typeReference];
        }
        //  Assert this is a registered type.
        if (!(typeReference in this.types)) throw new SchemaError(
            `Invalid type: ${ typeReference }`
        );

        //  Resolve the type and provide it with database access and its
        //  options. These are provided after construction for type map
        //  brevity.
        return this.types[typeReference]()._afterConstruction(this, options);
    }

    /**
    *   Return the model class for the given collection name. If it doesn't
    *   exist, return `null` or throw a schema error if specified.
    *
    *   In most cases, `_collectionReferenceToM` should be used instead as it
    *   has more comprehensive outward-facing behaviour.
    */
    _lookupM(collection, orDie=false) {
        if (orDie && !(collection in this.models)) throw new SchemaError(
            `No collection ${ collection } in database ${ this.name }`
        );
        
        return this.models[collection] || null;
    }

    /**
    *   Return the model class for the given collection reference or throw a
    *   schema error. This can be either a string containing a collection name
    *   or a model class itself; exposed interfaces that leverage this can 
    *   support both styles.
    */
    _collectionReferenceToM(reference) {
        if (reference.prototype instanceof Model) {
            //  This reference is already a model class, assert it belongs to
            //  this database.
            const localM = this._lookupM(reference._schema.collection);
            if (localM != reference) throw new SchemaError(
                `Foreign model ${ reference._schema }`
            )

            //  Return directly.
            return reference;
        }

        //  Assert the reference is otherwise a string.
        if (typeof reference != 'string') throw new SchemaError(
            'Collection reference must be Model subclass or collection name'
        );

        //  Resolve the model class from the registry or throw a schema error.
        return this._lookupM(reference, true);
    }

    /**
    *   Return the attribute identity corresponding to the provided attribute
    *   reference or throw a schema error. This reference can either be a
    *   string of the form `"<collection>.<attribute>"`, or an attribute
    *   identity (e.g. retrieved from `<ModelClass>.<attribute>`).
    */
    _attributeReferenceToIdentity(reference) {
        if (reference instanceof AttributeIdentity) {
            //  This reference is already an attribute identity, assert it
            //  belongs to this database.
            const localM = this._lookupM(reference.M._schema.collection);
            if (localM != reference.M) throw new SchemaError(
                `Foreign attribute ${ reference }`
            );

            //  Return directly.
            return reference;
        }

        //  Assert the reference is otherwise a string.
        if (typeof reference != 'string') throw new SchemaError(
            'Attribute reference must be AttributeIdentity or string'
        );
        //  Split the reference string and assert its format is valid.
        const [collectionReference, attribute, ...rest] = reference.split('.');
        if (!attribute || rest.length) throw new SchemaError(
            `Invalid attribute reference string format ${ reference }`
        );

        //  Resolve the collection part of the reference string or throw a
        //  schema error.
        const {_schema} = this._collectionReferenceToM(collectionReference);
        
        //  Assert the attribute key is valid.
        if (!(attribute in _schema.attributeIdentities)) throw new SchemaError(
            `${ _schema } has no attribute ${ attribute }`
        );
        //  Return the identity.
        return _schema.attributeIdentities[attribute];
    }

    /**
    *   Register a model class with this database. Discovers the collection
    *   name and schema template, asserting they're present, and attaches them
    *   directly to the model class and constructs a schema. 
    */
    _registerModel(M) {
        //  Assert the provided class is a model.
        if (!(M.prototype instanceof Model)) throw new SchemaError(
            `Registered model doesn't inherit for Model`
        );

        //  Check for schema template and collection name.
        if (!M.collection || !M.schema) {
            //  Try to read property-style definitions.
            const m = new M();
            M.collection = M.collection || m.collection;
            M.schema = M.schema || m.schema;

            //  Assert secondary definition method was implemented.
            if (!M.collection || !M.schema) throw new SchemaError(
                `${ M.name } missing collection or schema definition`
            );
        }
        
        //  Assert the model class isn't yet registered with a database and
        //  assign it to this one.
        if (M.database) throw new SchemaError(
            `Model already in a database: ${ M.database }`
        )
        M.database = this;

        //  Construct the schema for this model class.
        M._schema = ModelSchema._fromModelClass(this, M);
        M._schema._attachAttributeIdentities(M);
    
        //  Add this model class to the registry.
        this.models[M.collection] = M;
    }

    /**
    *   Construct and return a new session on this database.
    */
    session() {
        return new Session(this, () => this.pool.connect());
    }

    /**
    *   Return a callable that can be used to register a model class with the
    *   given collection name and optionally schema declaratively (i.e. with a
    *   decorator).
    * 
    *   All models should be registered with their databases before runtime.
    */
    collection(collectionName, schema=null) {
        return M => {
            M.collection = collectionName;
            if (schema) M.schema = schema;
            this._registerModel(M);
        };
    }

    /**
    *   Logically register a model with this database. 
    * 
    *   All models should be registered with their databases before runtime.
    */
    register(M) {
        this._registerModel(M);
    }

    toString() {
        return `${ this.name } (${ this.version })`
    }
}

//  Define exposures.
/**
*   Construct and return a database with the given name and optionally options.
*/
const constructDatabase = (name, options={}) => new Database(name, options);

/**
*   Return the database with the given name if a name is specified, or the
*   first registered database in undefined order, or null.
*/
const _retrieveDatabase = (name=null) => {
    name = name || Object.keys(_databases)[0];
    
    return _databases[name] || null;
}

//  Exports.
module.exports = { constructDatabase, _retrieveDatabase };
