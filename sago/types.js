/**
*   Model attribute type machinery and stock type definitions. Custom types
*   are specified during database creation, and must subclass `AttributeType`.
*
*   Types are invoked during attribute value lifecycle as well as value
*   serialization and de-serialization. There is one instance of an attribute
*   type for each attribute of each model.
*
*   Note that when defining model class schemas, types are not created
*   directly, but are instead referenced and configured with template data
*   structures.
*/
const { AttributeTypeError, AttributeValueError } = require('./errors');

//  The pattern used to validate UUID strings.
const UUID_PATTERN = /^[0-9a-f-]{36}|[0-9a-f]{32}$/;
//  The stock mappings used to associate type references in schema definitions
//  to actual attribute types.
const DEFAULT_TYPE_ALIAS_MAP = {
    bool: 'boolean',
    int: 'integer'
}
const DEFAULT_TYPE_MAP = {
    boolean: () => new AttributeType('boolean', 'boolean'),
    integer: () => new AttributeType('number', 'integer'),
    float: () => new AttributeType('number', 'float'),
    string: () => new StringAttributeType(),
    uuid: () => new UUIDAttributeType(),
    datetime: () => new DatetimeAttributeType()
};

//  XXX: Eagerly comprehend and validate options.
/**
*   The base attribute type class. Functional for "primitive" types without
*   inheritance.
*/
class AttributeType {
    constructor(nativeType, dbType) {
        this.nativeType = nativeType;
        this.dbType = dbType;
        this.database = null;

        //  Options are applied later.
        this.options = {};
    }

    /**
    *   Whether or not attributes of this type are nullable. 
    */
    get isNullable() { return this.options.nullable; }

    /**
    *    Whether or not this attribute type defines a foreign key.
    */
    get isForeignKey() { return !!this.options.fk; }
    
    /**
    *   Whether or not this attribute type defines a primary key. 
    */
    get isPrimaryKey() { return this.options.pk; }

    /**
    *   SQL defining the in-database default value for this type. 
    */
    get dbDefaultValue() { return this.options.default || null; }

    /**
    *   The identity of the destination attribute for this foreign key
    *   attribute type. Should only be accessed if this attribute type
    *   is known to define a foreign key.
    */    
    get foreignKeyDestinationIdentity() {
        //  Assert this type defines a foreign key.
        if (!this.isForeignKey) throw new Error(
            `${ this } isn't a foreign key (this may be a bug is sago)`
        );

        //  Resolve the attribute reference for this foreign key.
        return this.database._attributeReferenceToIdentity(this.options.fk);
    }

    /**
    *   Store and allow inheritors to process the options for this type
    *   definition, as supplied in a model schema. Chainable.
    */
    _afterConstruction(database, options) {
        this.database = database;
        this.options = options;
        this.attributeTypeDidConstruct();
        return this;
    }

    /**
    *   A lifecycle hook inheritors can use to inspect the supplied options and
    *   mutate as nessesary. 
    */
    attributeTypeDidConstruct() {}

    /**
    *   A provider invoked to generate the initial value for a this attribute
    *   type on a newly constructed (not reconstructed) model. 
    */
    _generateInitialValue() { return null; }

    /**
    *   A comparison function stub used for sorting many-side relationships in
    *   memory.
    */
    compareValues(a, b) { return a > b ? 1 : -1; }

    /**
    *   Return whether or not the given value is a valid member of this type.
    *   Note this does not enforce non-nullablity to allow coupling and other
    *   deferred construction.
    */
    validate(value) { return !value || typeof value == this.nativeType; }

    /**
    *   Raise an appropriate error if the given value fails the validation
    *   check for this type.
    */
    validateOrDie(value) {
        if (!this.validate(value)) throw new AttributeTypeError(
            value, this.nativeType
        );
    }

    /**
    *   Transform a serialized representation of a value of this type to a
    *   native one, or throw an appropriate `AttributeError`. Note this is 
    *   intended to de-serialize values arriving from external storage or
    *   transport and isn't invoked during model lifecycle.
    */
    deserialize(value) {
        this.validateOrDie(value);
        return value;
    }

    /**
    *   Transform a native representation of a value of this type to a
    *   serialized. As a benchmark, the returned value should be supported
    *   by `JSON.stringify`. See usage context note above.
    */
    serialize(value) { return value; }
}

/**
*   The string attribute type. Enforces native type strictly because lots of
*   people think type coersion is spooky. Attributes of this type will be
*   stored in:
*
*   ~ A `TEXT` column if no length is specified.
*   ~ A `VARCHAR` column if a length is specified.
*   ~ A `CHAR` column if a length and `fixed` are both specified.
*
*   Note this type strictly enforces length on the model attribute at
*   assignment time.
*/
class StringAttributeType extends AttributeType {
    constructor() {
        super('string', null);
    }

    attributeTypeDidConstruct() {
        const {length, fixed} = this.options;
        
        //  Decide the appropriate in-database type based on supplied options.
        this.dbType = (length ? 
            `${ fixed ? '' : 'var' }char(${ length })` 
            : 
            'text'
        );
    }

    /**
    *   Return whether or not the given value is too long. 
    */
    validateLength(value) {
        const {length} = this.options;
        if (!length) return true;

        return value.length <= length;
    }

    /**
    *   Return whether or not the given value is a string and is not too long.
    */
    validate(value) {
        return !value || (
            typeof value == 'string' && this.validateLength(value)
        );
    }

    /**
    *   Throw either an `AttributeTypeError` or `AttributeValueError` if the
    *   given value is non-null and invalid. 
    */
    validateOrDie(value) {
        if (!value) return;

        if (!super.validate(value)) throw new AttributeTypeError(
            null, value, 'string'
        );
        if (!this.validateLength(value)) throw new AttributeValueError(
            null, value, `expected length < ${ this.options.length }`
        );
    }
}

/**
*   The UUID attribute type. UUIDs are treated as strings natively. 
*/
class UUIDAttributeType extends AttributeType {
    constructor() {
        super(null, 'uuid');
    }

    /**
    *   Return whether or not the given value is in a 36 or 32 character UUID
    *   format.
    */
    validateFormat(value) {
        return UUID_PATTERN.test(value);
    }

    /**
    *   Return whether or not the given value is either null or in a string in
    *   a valid UUID format.
    */
    validate(value) {
        return !value || (typeof value == 'string' && UUID_PATTERN.test(value));
    }

    /**
    *   Throw either an `AttributeTypeError` or `AttributeValueError` if the
    *   given value is non-null and invalid. 
    */
    validateOrDie(value) {
        if (!value) return;

        if (typeof value != 'string') throw new AttributeTypeError(
            null, value, 'string'
        );
        if (!this.validateFormat(value)) throw new AttributeValueError(
            null, value, 'Invalid format'
        );
    }

    /**
    *   If this is specified as a primary key, or the default is specified as
    *   `true`, assign the in-database default to a UUID v4. 
    */
    attributeTypeDidConstruct() {
        const {pk, ...options} = this.options;

        if (options.default === true || pk) this.options.default = 'uuid_generate_v4()';
    }
}

/**
*   The datetime attribute type. Datetimes are treated as `Date`s natively and
*   ISO strings when serialized for or de-serialized from external transport or
*   storage. 
*/
class DatetimeAttributeType extends AttributeType {
    constructor() {
        super(Date, 'timestamp');
    }

    /**
    *   Return whether or not the given value is null or a `Date`. 
    */
    validate(value) {
        return !value || (value instanceof Date);
    }

    /**
    *   Serialize the given value as an ISO date string.
    */
    serialize(value) {
        return value.toISOString();
    }

    /**
    *   De-serialize the given value if it is an ISO date string or throw an
    *   appropriate `AttributeError`. 
    */
    deserialize(value) {
        //  Assert type.
        if (typeof value !== 'string') throw new AttributeTypeError(
            null, value, 'string'
        );

        //  Parse with failure safety.
        value = new Date(value);
        if (isNaN(value.getTime())) throw new AttributeValueError(
            null, value, 'ISO date format'
        );

        return value;
    }
}

//  Exports.
module.exports = { AttributeType, DEFAULT_TYPE_MAP, DEFAULT_TYPE_ALIAS_MAP };
