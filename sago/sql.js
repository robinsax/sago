const collectionCreationSql = schema => (
    `create table ${ schema.collection } (\n\t${
        Object.values(schema.attributeIdentities).map(({type, attribute}) => (
            typeCreationSql(type, attribute)
        )).join(',\n\t')
    }\n);`
);

const typeCreationSql = (type, attribute) => ([
    attribute,
    //  Column type.
    type.dbType, 
    //  Early constraints.
    type.isPrimaryKey && 'primary key',
    !type.isNullable && 'not null', 
    //  Default value.
    type.dbDefaultValue && `default ${ type.dbDefaultValue + '' }`,
    //  Foreign key constraint. Note the constraint is created as 
    //  initially deferred to allow simpler coupling logic (unless
    //  otherwise specified).
    type.isForeignKey && (identity => (
        `,\n\tconstraint ${ attribute }_fk foreign key (${ 
            attribute
        }) references ${ 
            identity.M._schema.collection 
        }(${ identity.attribute })`
    ))(type.foreignKeyDestinationIdentity)
].filter(a => a).join(' '));

const databaseCreationSql = database => ([
    `create database ${ database.name };`,
    `\\c ${ database.name }`,
    `create extension "uuid-ossp";`,
    ...Object.values(database.models).map(M => (
        collectionCreationSql(M._schema)
    ))
].join('\n\n'));


class FormatValue {
    constructor(value) {
        this.value = value;
    }
}

const processSqlTokens = tokens => {
    let values = [];

    tokens = tokens.flat(100).filter(a => a).map(token => {
        if (token instanceof FormatValue) {
            values.push(token.value);
            return `$${ values.length }`;
        }

        return token;
    });

    return [tokens.join(' ') + ';', values];
};


module.exports = {
    FormatValue, processSqlTokens,
    databaseCreationSql
};
