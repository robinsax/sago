/**
*   The sago command line interface entry point and verb definitions. 
*/
const { _getDatabase } = require('./database');

//  Define the help message.
const HELP = `
node sago
    help OR --help
        Show this message.
    up --app=<app_path> (optional: --db=<database_name>)
        Emit up SQL for the given app. Specify a database if the app creates
        more than one.
`.trim();
//  Define option shorthands.
const FLAG_SHORTHANDS = {
    h: 'help',
    a: 'app'
};

/**
*   A CLI verb to output the up SQL for the application at the specified path.
*   A specific database name can be specified if the application defines more
*   than one. 
*/
const sqlizeSpecified = ({app, db, down, ...others}, reject) => {
    //  Ensure command line is valid.
    if (Object.keys(others).length || !app) return reject();

    //  Try to import the target so it can create a database.
    try {
        require('.' + app);
    }
    catch (err) {
        return reject(`Can't import: ${ app } (${ err })`);
    }

    //  Retrieve the created database
    const database = _getDatabase(db || null);
    if (!database) return reject(`No database ${ db } created by ${ app }`);

    //  Emit SQL.
    if (down) console.log(database.sqlizeDown());
    console.log(database.sqlize());
}

/**
*   Run the sago CLI. Returns the suggested exit code.
*/
const cli = () => {
    const [nodeExe, packagePath, verb, ...flags] = process.argv;

    //  Define helpers.
    /**
    *   Reject the command line arguments. 
    */
    const rejectArguments = (message=null) => {
        process.stderr.write(message || 'Invalid command line');
        process.stderr.write(HELP);
        return 1;
    }

    //  Parse the flags specified at the command line into a key, value map.
    const flagMap = {};
    flags.forEach(flag => {
        if (flag.startsWith('--')) flag = flag.substring(2);
        else if (flag.startsWith('-')) {
            flag = FLAG_SHORTHANDS[flag.substring(1)];
            if (!flag) return rejectArguments();
        }
        else return rejectArguments();

        //  Handle a key, value pair.
        let value = true;
        if (flag.indexOf('=') >= 0) {
            [flag, ...value] = flag.split('=');
            value = value.join('=');
        }
        flagMap[flag] = value;
    });

    //  Perform verb.
    switch (verb) {
        case 'up': return sqlizeSpecified(flagMap, rejectArguments); break;
        default: return rejectArguments();
    } 
}

//  Export.
module.exports = cli;
