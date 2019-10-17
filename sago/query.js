
/**
*   Validate the shape of the supplied order components and resolve them into
*   an array of key, attribute type definition pairs. If there are no order
*   components provided, return null.
*/
const resolveOrderComponents = (components, schema) => {
    //  Ensure a value exists.
    if (!components) return null;
    //  Comprehend the provided schema.
    const {identities} = schema;

    //  Define a helper.
    /**
    *   Resolve an order component into an identity and value or die. 
    */
    const resolveOneOrDie = component => {
        let result = null;
        if (typeof component == 'object') {
            //  Ensure there is exactly one key and it corresponds to an
            //  attribute identity.
            const keys = Object.keys(component);
            if (keys.length == 1 && keys[0] in identities) result = {
                identity: identities[keys[0]], value: component[keys[0]]
            };
        }

        if (!result) throw new Error(
            'order() components must be array of, or one, attribute reference'
        );

        return result;
    }

    //  If the supplied parameter isn't a set, try to resolve it as a single
    //  value.
    if (!(components instanceof Array)) return [resolveOneOrDie(components)];

    //  Try to resolve all elements in the array.
    return components.map(resolveOneOrDie);
}

/**
*   A database query. Unlike other libraries, results must be explicitly
*   requested. The `first(n)` and `all()` methods retrieve rows asynchronously.
*
*   Queries are immutable but are used in chains by returning copies of
*   themselves with token and value lists being expanded for each modifying
*   call.
*/
class Query {
    /**
    *   See `Session.query` for documentation on constructing sessions. 
    */
    constructor(
        session, M, conditionTokens=null, conditionValues=null,
        orderComponents=null
    ) {
        this.session = session;
        this.M = M;
        this.conditionTokens = conditionTokens || [];
        this.conditionValues = conditionValues || [];
        this.orderComponents = orderComponents;
    }

    /**
    *   Return a copy of this query with the changes specified by the given
    *   update object. 
    */
    _copy(updateObject) {
        //  Create a copy.
        const next = new Query(
            this.session, this.M, this.conditionTokens, this.conditionValues,
            this.orderComponents
        );
        //  Perform updates.
        Object.keys(updateObject).forEach(key => {
            next[key] = updateObject[key];
        });

        //  Return the copy.
        return next;
    }

    /**
    *   Return this query with an additional set of conditions. The provided
    *   condition map should contain attribute names as keys and either scalar
    *   values or arrays with `['<comparator>', <scalar_value>]`. The
    *   comparator defaults to '='.
    * 
    *   The supplied conjunctive can be any boolean comparator, but should
    *   *not* be accepted from an untrusted source.
    * 
    *   Type validation is performed on all supplied values.
    */
    where(conditionMap, conjunctive='and') {
        //  Assert parameter type is valid.
        if (typeof conditionMap != 'object') {
            throw new Error('Invalid where() condition');
        }
        const {_schema: {attributes}} = this.M, newTokens = [], newValues = [];

        const conditionKeys = Object.keys(conditionMap);
        conditionKeys.forEach((key, i) => {
            //  Assert this is a valid attribute key and resolve the
            //  corresponding type.
            if (!(key in attributes)) {
                throw new SchemaError(`Out of schema attribute: ${ key }`);
            }
            const type = attributes[key];

            //  Comprehend comparator, scalar value pairs.
            let value = conditionMap[key], comparator = '=';
            if (value instanceof Array) [comparator, value] = value;

            //  Perform type validation.
            !type.validateOrDie(value);

            //  Expand token and value sets.
            newTokens.push(key);
            if (value === null) {
                //  Handle special null comparators with assertion.
                if (comparator == '=') comparator = 'is';
                if (comparator == '!=') comparator = 'is not';
                if (comparator != 'is' && comparator != 'is not') {
                    throw new Error(
                        `Invalid comparator for null: ${ comparator }`
                    );
                }
            }
            
            newTokens.push(comparator);
            newTokens.push('$' + (this.conditionValues.length + i + 1));
            newValues.push(value);

            if (i != conditionKeys.length - 1) newTokens.push(conjunctive);
        });
        
        //  Return next query.
        return this._copy({
            conditionTokens: [...this.conditionTokens, ...newTokens],
            conditionValues: [...this.conditionValues, ...newValues]
        });
    }

    /**
    *   Return a query with an `AND` conjunctive appened.
    */
    and() {
        return this._copy({
            conditionTokens: [...this.conditionTokens, 'and']
        });
    }

    /**
    *   Return a query with an `OR` conjunctive appended. 
    */
    or() {
        return this._copy({
            conditionTokens: [...this.conditionTokens, 'or']
        });
    }

    /**
    *   Return a query with the given ordering. The supplied ordering should be
    *   a list of one-hot attribute name, order maps, where the per-attribute
    *   order is either 'asc' or 'desc'. Note the order should *not* be
    *   accepted from an un-trusted source.
    */
    order(orderComponents) {
        if (!orderComponents) return this._copy({orderComponents: null});
        const {_schema: {attributes}} = this.M;

        //  Resolve attribute references into key, attribute type definition
        //  pairs and assert shape.
        orderComponents = resolveOrderComponents(
            orderComponents, this.M._schema
        );

        //  Return the updated query.
        return this._copy({orderComponents});
    }

    /**
    *   A protected variant of order component assignment for order component
    *   sets that have already been transformed and validated. Leveraged by
    *   relationship proxies.
    */
    _withValidatedOrder(orderComponents) {
        return this._copy({orderComponents});
    }


    /**
    *   Asynchronously load and reconstruct the models specified by this query,
    *   to the given limit if one is provided.
    */
    async _loadModels(limit=null) {
        const {conditionTokens, conditionValues, orderComponents} = this,
            {_schema: {collection}} = this.M;

        //  Retrieve rows.
        const {rows} = await this.session.emit(`
            select * from ${ collection }
                where ${ 
                    conditionTokens.length ? conditionTokens.join(' ') : 'true'
                }
                ${ limit === null ? '' : 
                    `limit $${ conditionValues.length + 1 }` 
                }
                ${ !orderComponents ? '' : (
                    `order by ${ orderComponents.map(o => (
                        o.identity.attribute + ' ' + o.value
                    )).join(', ') }`
                ) };
        `, [...conditionValues, ...(limit ? [limit] : [])]);
        
        //  Resolve each row into a model and return the result.
        return rows.map(r => this.session._resolveModel(this.M, r));
    }

    /**
    *   Return a promise resolving to the first number of models for this
    *   query. Note that if the specified count is higher than the number of
    *   matching models, less models than that will be returned. If count is 1,
    *   a single model or `null` will be returned.
    */
    async first(count=1) {
        const result = await this._loadModels(count);

        if (count == 1) return result.length ? result[0] : null;
        else return result;
    }

    /**
    *   Return as many models as are specified by this query. 
    */
    async all() {
        return this._loadModels();
    }
}

module.exports = { Query, resolveOrderComponents };