const fs = require('fs');

process.env.PGDATABASE = 'sago_test';
process.env.PGUSER = 'sago_test';
process.env.PGPASSWORD = 'sago_test';

const sago = require('sago');

const { AssertionSet } = require('./assertions');
const { IngredientType, Ingredient, Recipe, IngredientItem } = require('./model');

const database = sago('sago_test', {models: [IngredientType, Ingredient, Recipe, IngredientItem]});
const test = new AssertionSet();

if (require.main == module) {
    (async () => {
        const suites = fs.readdirSync(__dirname + '/suites');

        for (let i = 0; i < suites.length; i++) {
            let suite = suites[i];
            console.log('----', suite);

            try {
                await require(__dirname + '/suites/' + suite)(database, test);
            }
            catch (err) {
                test.error(err.stack);
                console.log('-- suite error');
            }
        }

        test.report();
        process.exit((test.failed || test.errored) ? 1 : 0);
    })();
}
