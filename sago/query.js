/**
*   Query abstraction and supporting machinery. Similar to other ORMs, queries
*   are repesented by chainable objects. Queries leverage their parent sessions
*   to execute.
*
*   This module encapsulates all runtime-SQL awareness.
*/
const { ParameterError, QueryError } = require('./errors');
const { FormatValue, processSqlTokens } = require('./utils');

//  The set of permitted logical conjunctives.
const CONJUNCTIVES = ['and', 'or'];
//  The set of permitted orders.
const ORDERS = ['asc', 'desc'];

/**
*   Validate the shape of the supplied externally supplied order component
*   templates and transform them into an array of attribute identity, value
*   pairs using the given schema. If there are no order components provided,
*   return `null`.
*/
const resolveOrderTemplate = (componentTemplates, schema) => {
    //  Ensure a value was provided.
    if (!componentTemplates) return null;

    //  Define a helper.
    /**
    *   Resolve an order component into an identity and value or throw a
    *   parameter error.
    */
    const resolveOneOrDie = componentTemplate => {
        if (typeof componentTemplate == 'object') {
            //  Ensure there is exactly one key and it corresponds to an
            //  attribute identity.
            const keys = Object.keys(componentTemplate);
            if (keys.length == 1 && keys[0] in schema.attributeIdentities) {
                //  Assert the value is a valid order string.
                const value = componentTemplate[keys[0]];
                if (ORDERS.indexOf(value) == -1) throw new ParameterError(
                    `Invalid order ${ value }`
                );

                return {identity: schema.attributeIdentities[keys[0]], value};
            }
        }

        //  Failed to parse, the input shape was invalid.
        throw new ParameterError(
            `order components must be array of, or one, attribute reference(s)`
        );
    }

    //  If the supplied parameter isn't a set, try to resolve it as a single
    //  value.
    if (!(componentTemplates instanceof Array)) return [
        resolveOneOrDie(componentTemplates)
    ];

    //  Try to resolve all elements in the array.
    return componentTemplates.map(resolveOneOrDie);
}

/**
*   Queries are responsible for creating, validating, and tokenizing SQL
*   queries. They leverage their parent session to emit SQL and sessions
*   leverage these objects to execute queries. Queries also provide sessions
*   with opportunities to update their state based on query operations when
*   applicable.
*
*   This object encapsulates the majority of the query state in its "essence".
*   Currently, all queries are rooted on model class schema.
*
*   Note that query read operations return models but write operations
*   don't accept model parameters as the session should be used instead. Side
*   effects caused by query write operations are applied to loaded models where
*   nessesary, but using a query to modify loaded models isn't suggested as it
*   may result in confusing behavior.
*/
class Query {
    /**
    *   Construct a new query, reserved for `Session.query()`. 
    */
    constructor(session, M) {
        this.session = session;
        this.M = M;
        
        //  The essence is a descriptor of this query generated via chaining.
        this.essence = {};

        //  Flags for the existance of one-of modifiers that are difficult to
        //  search for in the session.
        this.hasOrder = false;
        this.hasLimit = false;
    }
    
    /**
    *   The host schema of this query. 
    */
    get hostSchema() { return this.M._schema; }

    /**
    *   Mutate the essence of this query using a pure function parameter. This
    *   pattern is used to allow easy mutation control in the future. 
    */
    _mutateEssence(essenceUpdate) {
        this.essence = essenceUpdate(this.essence);

        return this;
    }

    /**
    *   Retrieve a select set of keys from this querys essence while ensuring
    *   that it has not been constructed into an insane state. 
    */
    _validatedEssence(...readKeys) {
        //  Assert no extraneous keys are present.
        Object.keys(this.essence).forEach(key => {
            if (readKeys.indexOf(key) == -1) throw new QueryError(
                `Invalid query (impossible ${ key })`
            );
        });

        return this.essence;
    }

    /**
    *   Append a logical conjunctive to the conditions of this query. 
    */
    _addConjunctive(conjunctive) {
        return this._mutateEssence(({conditions, ...essence}) => ({
            conditions: [...(conditions || []), conjunctive], ...essence
        }));
    }

    /**
    *   Add a set of conditions to the query. The keys of the condition set
    *   template should be attribute values in the host schema of this query,
    *   and the values should be either correctly-typed values, or an array
    *   containing a comparator string and a correctly typed value. 
    */
    where(conditionTemplate, conjunctive='and') {
        //  Assert the conjunctive is valid.
        if (CONJUNCTIVES.indexOf(conjunctive) == -1) throw new QueryError(
            `Invalid conjunctive ${ conjunctive }`
        );
        //  Assert the condition template is an object.
        if (typeof conditionTemplate != 'object') throw new QueryError(
            `Invalid condition template ${ conditionTemplate }`
        );

        //  Reduce the condition template into a validated set of SQL tokens.
        const templateKeys = Object.keys(conditionTemplate);
        const addedConditions = templateKeys.reduce((result, attribute, i) => {
            //  Resolve the identity of this attribute, which asserts that it
            //  is in-schema.
            const identity = this.hostSchema._ownAttributeReferenceToIdentity(
                attribute
            );

            //  Resolve the value and comparator to use.
            let value = conditionTemplate[attribute], comparator = '=';
            if (value instanceof Array) [comparator, value] = value;
            
            //  Allow the attribute type definition to validate the value.
            identity.contextAwareValidateOrDie(value);
            
            //  Maybe handle the special SQL syntax required for comparison
            //  with NULL.
            if (value === null) {
                switch (comparator) {
                    case 'is':
                    case '=': comparator = 'is'; break;
                    case 'is not':
                    case '!=': comparator = 'is not'; break;
                    default: throw new ParameterError(
                        `Invalid comparator for null: ${ comparator }`
                    );
                }
            }

            //  Extend and return the result.
            return [
                ...result, attribute, comparator, new FormatValue(value),
                i < templateKeys.length - 1 && conjunctive
            ];
        }, []);
        
        //  Update the essence with the new conditions.
        return this._mutateEssence(essence => ({
            ...essence,
            conditions: [essence.conditions, addedConditions]
        }));
    }

    /**
    *   Append an AND conjunctive between WHERE causes. 
    */
    and() {
        return this._addConjunctive('and');
    }

    /**
    *   Append an OR conjunctive between WHERE causes. 
    */
    or() {
        return this._addConjunctive('or');
    }

    /**
    *   Set the order for the query. If the provided order template is null,
    *   any existing ordering is removed. Otherwise, the order template should
    *   be a list of objects, each containing a single in-schema attribute key
    *   and a value of either "asc" or "desc".
    * 
    *   The second parameter is reserved for internal use. 
    */
    order(orderTemplate, _isTemplate=true) {
        if (!orderTemplate) {
            //  The caller wants to remove any existing order from the query.
            this.hasOrder = false;
            
            //  Filter out modifiers with the relevant initial token.
            return this._mutateEssence(essence => ({
                ...essence,
                modifiers: (essence.modifiers || []).filter(modifier => (
                    modifier[0] != 'order by'
                ))
            }))
        };
        //  Respect the one-order-per-query lock.
        if (this.hasOrder) throw new QueryError('Query already has order');
        this.hasOrder = true;

        //  Resolve attribute references into key, attribute type definition
        //  pairs, which asserts their shape, unless a library internal caller
        //  already did so.
        const resolvedTemplate = !_isTemplate ? 
            orderTemplate 
            : 
            resolveOrderTemplate(orderTemplate, this.M._schema);
        //  Resolve the indentity, value pairs into ordering SQL tokens.
        const ordering = resolvedTemplate.map(({identity, value}) => ([
            identity.attribute, value
        ])).flat();

        //  Return the updated query.
        return this._mutateEssence(essence => ({
            ...essence,
            modifiers: [...(essence.modifiers || []), ['order by', ordering]]
        }));
    }

    /**
    *   Apply a result limit to this query. The provided limit must be a
    *   positive number.
    */
    limit(limit) {
        //  Respect the one-limit-per-query lock.
        if (this.hasLimit) throw new QueryError('Query already has limit');
        this.hasLimit = true;

        //  Assert the provided limit is valid.
        if (typeof limit != 'number' || limit < 0) throw new QueryError(
            `Invalid limit ${ limit }`
        ); 

        //  Return the updated query.
        return this._mutateEssence(essence => ({
            ...essence, modifiers: [
                ...(essence.modifiers || []),
                ['limit', new FormatValue(limit)]
            ]
        }));
    }

    /**
    *   Specify the return values for this query. The provided attribute
    *   references can optionally be passed in an array. 
    */
    return(...attributeReferences) {
        //  Flatten the attribute reference set.
        attributeReferences = attributeReferences.flat();

        //  Transform the attribute references to SQL. Note this also validates
        //  each one.
        const returns = attributeReferences.map((reference, i) => ([
            this.hostSchema._ownAttributeReferenceToIdentity(
                reference
            ).attribute,
            i != attributeReferences.length - 1 && ','
        ]));

        //  Return the updated query.
        return this._mutateEssence(essence => ({...essence, returns}));
    }

    /**
    *   Retrieve and return the list of results for this query. If no return
    *   values were explicitly specified, a list of models loaded into the
    *   parent session of this query are returned. Otherwise, simple row
    *   objects are returned.
    */
    async all() {
        //  Comprehend and validate this querys essence.
        const {conditions, modifiers, returns} = this._validatedEssence(
            'conditions', 'modifiers', 'returns'
        );

        //  Retrieve the rows.
        const {rows} = await this.session._emit(...processSqlTokens([
            'select', returns || '*',
            'from', this.hostSchema.collection,
            'where', conditions || 'true',
            modifiers
        ]));
        //  If a return value set was explicitly specified, return the pure
        //  rows.
        if (this.essence.returns) return rows;

        //  ...otherwise resolve the rows to models using the parent session.
        return rows.map(row => this.session._resolveModel(this.M, row));
    }

    /**
    *   Retrieve the first `n` results for this query. If `n=1`, a scalar value
    *   is returned, otherwise a list is. Shares the behaviour of `all()`. 
    */
    async first(count=1) {
        const result = await this.limit(count).all();

        return count == 1 ? result[0] || null : result;
    }

    /**
    *   Delete the rows specified by this query, and return a list of return
    *   values if this query has any. Applies relational and other side effects
    *   on loaded models when used outside library scope.
    * 
    *   The parameters are reserved for internal use.
    */
    async delete(_applySideEffects=true) {
        //  Comprehend and validate this querys essence.
        let {conditions, returns} = this._validatedEssence(
            'conditions', 'returns'
        );

        //  Retrieve the primary key identity in the host schema, which is
        //  manually specified for return to allow side effects of the deletion
        //  on loaded models to be performed.
        const {primaryKey} = this.hostSchema;
        //  Filter the primary key out of the specified set to prevent
        //  duplication.
        returns = (returns || []).filter(attribute => (
            attribute != primaryKey.attribute
        ));

        //  Emit the deletion and retrieve the deleted rows.
        const {rows} = await this.session._emit(...processSqlTokens([
            'delete from', this.hostSchema.collection,
            'where', conditions || 'true',
            'returning', primaryKey.attribute, returns
        ]));
        //  Inform the session what happened to it can apply side effects
        //  (unless instructed not to).
        if (_applySideEffects) rows.forEach(row => (
            this.session._queryDeletedRow(this.M, row)
        ));
        
        //  Return the rows to the caller.
        return rows;
    }

    /**
    *   Perform an update on the rows specified by this query, and return a
    *   list of retrieved values if any are being returned. The update template
    *   should be and object containing in-schema attribute keys and correctly
    *   typed values.
    */
    async update(updateTemplate) {
        //  Assert the update tempate is valid.
        if (typeof updateTemplate != 'object' || !updateTemplate) throw (
            new QueryError(`Invalid update template ${ updateTemplate }`)
        );

        //  Transform the update template to SQL tokens, and validate value
        //  types.
        const updateKeys = Object.keys(updateTemplate);
        const updates = updateKeys.map((attribute, i) => {
            //  Retrieve the incoming value and identity for this attribute.
            const value = updateTemplate[attribute],
                identity = this.hostSchema._ownAttributeReferenceToIdentity(
                    attribute
                );

            //  Allow the type to validate the value.
            identity.contextAwareValidateOrDie(value);

            //  Return the tokens.
            return [
                attribute, '=', new FormatValue(value), 
                i < updateKeys.length - 1 && ','
            ];
        });

        //  Retrieve the validated essence.
        const { conditions, returns } = this._validatedEssence(
            'conditions', 'returns'
        );
        
        //  Emit the update and return the row set to the caller.
        const {rows} = await this.session._emit(...processSqlTokens([
            'update', this.hostSchema.collection,
            'set', updates,
            'where', conditions || 'true',
            returns && ['returning', returns]
        ]));
        return rows;
    }

    /**
    *   Perform an insertion into the host collection of this query. The row
    *   template should contain in-schema attribute keys and correctly typed
    *   values. A row containing values specified for return is returned.
    */
    async insert(rowTemplate) {
        //  Assert the row template is valid.
        if (typeof rowTemplate != 'object' || !rowTemplate) throw (
            new QueryError(`Invalid row template ${ rowTemplate }`)
        );

        //  Transform the provided row template into attribute, value pairs
        //  with type validation.
        const insertions = Object.keys(rowTemplate).map(attribute => {
            //  Resolve the incoming value and attribute identity.
            const value = rowTemplate[attribute],
                identity = this.hostSchema._ownAttributeReferenceToIdentity(
                    attribute
                );

            //  Allow the type definition to assert the value is valid.
            identity.contextAwareValidateOrDie(value);

            //  Return the attribute and value as a named pair.
            return {attribute, value: new FormatValue(value)};
        });

        //  Retreive the validated essence.
        const {returns} = this._validatedEssence('returns');

        //  Retrieve the result columns if there are any and provide them to
        //  the caller. 
        const {rows} = await this.session._emit(...processSqlTokens([
            'insert into', this.hostSchema.collection,
            '(', insertions.map(({attribute}) => attribute).join(', '), ')',
            'values',
            '(', insertions.map(({value}, i) => [
                value, i < insertions.length - 1 && ','
            ]), ')',
            returns && returns.length && ['returning', returns]
        ]));
        return rows[0] || null;
    }
}

//  Exports.
module.exports = { Query, resolveOrderTemplate };
