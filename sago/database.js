/**
*   Database machinery and schema tool definitions. `Database`s are the
*   fundamental components of sago. Both `Model` classes and `Session`
*   instances belong to a specific database.
*
*   The encouraged pattern is to create a database either immediately after
*   requiring sago, or after you have defined the constituents of your data
*   model.
*/
const { Pool } = require('pg');

const { DEFAULT_TYPE_ALIAS_MAP, DEFAULT_TYPE_MAP } = require('./types');
const { SchemaError } = require('./errors');
const { Session } = require('./session');

//  Define a master table of all defined databases.
const databases = {};

/**
*   Model schemas are comprehensions of the schema template and collection name
*   specified for a model class. Each model class is assigned its corresponding
*   schema as `_schema`.
*
*   The methods and properties exposed here should not be considered stable,
*   they are exclusively for internal use. 
*/
class ModelSchema {
    /**
    *   Comprehend a schema template and return a corresponding model schema. 
    */
    static fromTemplate(database, collection, template) {
        //  Resolve attribute types and find the primary key.
        let pkAttribute;
        const attributes = Object.keys(template).reduce((attributes, key) => {
            //  Comprehend the value for this attribute provided in the
            //  template.
            const templateValue = template[key];
            let typeReference = templateValue, options = {};
            if (templateValue instanceof Array) {
                [typeReference, options] = templateValue;
            }

            //  Store primary key if this is it.
            if (options.pk) pkAttribute = key;

            //  Update the attribute map.
            attributes[key] = database._parseType(typeReference, options);
            return attributes;
        }, {});

        //  Assert we found a primary key and return the result model schema.
        if (!pkAttribute) {
            throw new SchemaError(`No primary key for ${ collection }`);
        }
        return new ModelSchema(database, collection, attributes, pkAttribute);
    }

    constructor(database, collection, attributes, pkAttribute) {
        this.database = database;
        this.collection = collection;
        this.attributes = attributes;
        this.pkAttribute = pkAttribute;
    }

    /**
    *   Return the up SQL for this table. 
    */
    sqlize() {
        return `create table ${ this.collection } (\n\t${
            Object.keys(this.attributes).map(attr => {
                const type = this.attributes[attr];

                return `${ attr } ${ type.sqlize(attr) }`
            }).join(',\n\t')
        }\n);`;
    }
}

class Database {
    /**
    *   See `sago()` for documentation on constructing databases. 
    */
    constructor(name, options={}) {
        this.name = name;
        
        //  Create a connection pool into this database.
        this.pool = new Pool({...(options.pg || {}), database: this.name});

        //  Resolve type and type alias maps.
        this.types = DEFAULT_TYPE_MAP;
        this.typeAliases = DEFAULT_TYPE_ALIAS_MAP;
        if (options.types) this.types = {...this.types, ...options.types};
        if (options.typeAliases) {
            this.typeAliases = {...this.typeAliases, ...options.typeAliases};
        }

        //  Create the model class registry and add all initially provided
        //  model classes.
        this.models = {};
        if (options.models) options.models.forEach(M => this._register(M));

        //  Bind exposed methods and register this database with the global
        //  registry.
        this.register = this.register.bind(this);
        databases[this.name] = this;
    }
    
    /**
    *   Return a new type constructed from the given type reference string and
    *   options objects. 
    */
    _parseType(typeReference, options={}) {
        //  Maybe follow an alias.
        if (typeReference in this.typeAliases) {
            typeReference = this.typeAliases[typeReference];
        }
        //  Assert this is a registered type.
        if (!(typeReference in this.types)) {
            throw new SchemaError(`Invalid type: ${ typeReference }`);
        }

        //  Resolve the type and provide it with options.
        return this.types[typeReference]().takeOptions(options);
    }


    /**
    *   Return the model class for the given collection nam or null.
    */
    _getModel(collectionName) {
        return this.models[collectionName] || null;
    }

    /**
    *   Register a model class to this database. 
    */
    _register(M) {
        if (!M.collection || !M.schema) {
            //  Read property-style definitions as a fallback.
            const m = new M();
            M.collection = M.collection || m.collection;
            M.schema = M.schema || m.schema;

            //  Assert secondary definition method was implemented.
            if (!M.collection || !M.schema) {
                throw new SchemaError(
                    `${ M.name } missing collection or schema definition`
                );
            }
        }
        
        //  Assign model to this database.
        M.database = this;
        //  Comprehend schema and store as a protected attribute on the model
        //  class.
        M._schema = ModelSchema.fromTemplate(this, M.collection, M.schema);

        //  Add this model class to the registry.
        this.models[M.collection] = M;
    }

    /**
    *   Return a new session (complex curson) on this database.
    */
    session() {
        return new Session(this, () => this.pool.connect());
    }

    /**
    *   Return a callable that can be used to register a model class with the
    *   given collection name and optionally schema. This method is intended to
    *   be used as a class decorator for apps building with a transpiler.
    */
    register(collectionName, schema=null) {
        return M => {
            M.collection = collectionName;
            if (schema) M.schema = schema;
            this._register(M);
        };
    }

    /**
    *   Return up SQL for this database, excluding role and permissions
    *   configuration. 
    */
    sqlize() {
        //  XXX: Could be more extensible...
        return [
            `create database ${ this.name };`,
            `\\c ${ this.name }`,
            `create extension "uuid-ossp";`,
            ...Object.values(this.models).map(M => (
                M._schema.sqlize()
            ))
        ].join('\n\n');
    }

    /**
    *   Return down SQL for this database. 
    */
    sqlizeDown() {
        return `drop database ${ this.name };`;
    }
}

/**
*   Create a database with the given name and options. Options can include a
*   set of `Model` classes (`models`), type system extensions (`types`, 
*   `typeAliases`), and configuration to be passed directly to `node-postgres`
*   (`pg`).
*/
const createDatabase = (name, options={}) => new Database(name, options);

/**
*   Return the database with the given name if a name is specified, or the first
*   registered database in undefined order, or null.
*/
const _getDatabase = (name=null) => {
    name = name || Object.keys(databases)[0];
    
    return databases[name] || null;
}

//  Exports.
module.exports = { createDatabase, _getDatabase };
