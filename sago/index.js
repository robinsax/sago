/**
*   sago is a mini-ORM for node & PostgreSQL. This package is organized into
*   the following modules:
*
*   ~ `attributes` contains model attribute identities and proxies.
*   ~ `cli` contains functional entry points.
*   ~ `database` contains top-level model and type set aggregations and schema
*     comprehension machinery.
*   ~ `errors` contains externally-exposed error type definitions.
*   ~ `model` contains base model class definition and supporting machinery.
*   ~ `query` contains database query abstraction as chainable objects.
*   ~ `relations` contains relation proxy definitions and supporting machinery.
*   ~ `session` contains sessionized database access machinery.
*   ~ `sql` contains internal data structure SQL serialization.
*   ~ `types` contains model attribute type system and stock definitions.
*   ~ `utils` contains object manipulation and similar utilities.
*/
const { constructDatabase } = require('./database');
const { Model } = require('./model');

//  Build exposure.
module.exports = (expose => {
    //  Primary export is the setup callable.
    const sago = constructDatabase;
    //  Export a named variant too.
    expose.sago = sago;

    //  Copy exposure set.
    Object.keys(expose).forEach(key => {
        sago[key] = expose[key];
    });

    return sago;
})({ Model, ...require('./errors') });

//  Maybe run the CLI.
if (require.main == module) require('./cli')();
