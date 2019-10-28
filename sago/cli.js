/**
*   The command line interface machinery. For ease of implementation, and since
*   the use case is limited, the command line interface only operates on a verb
*   and set of switches.
*/
const { databaseCreationSql } = require('./sql');
const { _retrieveDatabase } = require('./database');

//  The help message.
const HELP = `Usage: node sago
    help OR --help
        Show this message.
    up --app=<app_path> (optional: --db=<database_name>, --full, --down)
        Write table or full database creation SQL for the given app to stdout.
        Specify the database name if the app defines more than one.`;

/**
*   An error thrown when command line input parsing fails. 
*/
class InvalidInvocation extends Error {
    constructor(message) {
        super();
        this.message = message;
    }
}

/**
*   Output the table or full database creation SQL for the application at the
*   specified path. A database name must be specified if the application
*   defines more than one. 
*/
const writeCreationSql = ({app, db, down, full, ...others}) => {
    //  Assert command line is valid.
    if (Object.keys(others).length || !app) throw new InvalidInvocation(
        `Invalid options: ${ Object.keys(others) }`
    );

    //  Try to import the target so it can define a database and schema.
    try {
        require(`.${ app }`);
    }
    catch (err) {
        console.log(err.stack);
        throw new InvalidInvocation(`Can't import "${ app }"`);
    }

    //  Retrieve the specified database, or a registered database in no
    //  order.
    const database = _retrieveDatabase(db || null);
    if (!database) throw new InvalidInvocation(
        `Database "${ db }" was not defined in "${ app }"`
    );

    //  Write creation SQL.
    //  XXX: Use a source other than process.env for these parameters.
    const { PGUSER: username, PGPASSWORD: password } = process.env;
    console.log([
        `/** ${ database } */`,
        down && `drop database ${ database.name };`,
        full && `
            create user ${ username };
            alter user ${ username } with login;
            alter user ${ username } with password '${ password }';
        `,
        databaseCreationSql(database),
        full && `
            grant all privileges on all tables in schema public to ${ 
                password 
            };
        `
    ].filter(a => a).join('\n'));

    return 0;
}

/**
*   Transform the list of strings of the format "--key --key2=value" into a
*   key, value map.
*/
const parseFlagStrings = switchStrings => (
    switchStrings.reduce((resultSwitches, switchString) => {
        //  Assert the token is a valid switch and remove the prefix.
        if (!switchString.startsWith('--')) throw new InvalidInvocation(
            `Bad token: ${ switchString }`
        );
        switchString = switchString.substring(2);
        
        //  Parse a value from the switch if one is present.
        let value = true;
        if (switchString.indexOf('=') >= 0) {
            [switchString, ...value] = switchString.split('=');
            value = value.join('=');
        }
        //  Aggregate.
        resultSwitches[switchString] = value;
        return resultSwitches;
    }, {})
);

/**
*   Invoke the command line interface. Note that representations of command
*   line arguments can be passed as parameters to allow programatic invocation.
*
*   Returns the resultant process exit code.
*/
const cli = (...args) => {
    //  Resolve the verb and key, value "switch" map from either this functions
    //  arguments or the process command line arguments.
    let verb = null, switches = null;
    if (args.length) [verb, switches] = args;
    else {
        const [exePath, thisPath, verbString, ...flagStrings] = process.argv;

        verb = verbString;
        switches = parseFlagStrings(flagStrings);
    }

    //  Invoke the verb with safety.
    try {
        switch (verb) {
            case 'up':
                return writeCreationSql(switches);
            default:
                throw new InvalidInvocation(`Invalid verb: "${ verb }`);
        }
    }
    catch (err) {
        if (!(err instanceof InvalidInvocation)) throw err;

        //  Provide rejection message and help.
        process.stderr.write(`${ err.message }\n\n${ HELP }`);
        return 1;
    }
}

//  Export.
module.exports = cli;
