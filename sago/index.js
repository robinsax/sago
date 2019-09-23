/**
*   sago is an opinionated mini-ORM for PostgreSQL. It's designed for
*   practical use, minimum abstraction, and low complexity.
*/
const cli = require('./cli');
const { createDatabase } = require('./database');
const { Model } = require('./model');

//  Build exposure.
module.exports = (expose => {
    //  Primary export is the setup callable.
    const sago = createDatabase;
    //  Export a named variant too.
    expose.sago = sago;

    //  Copy exposure set.
    Object.keys(expose).forEach(key => {
        sago[key] = expose[key];
    });

    return sago;
})({Model, ...require('./errors') });

//  Maybe run the CLI.
if (require.main == module) cli();
