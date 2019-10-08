const { Recipe } = require('../model');

const testReconstruction = async (database, test) => {
    const session = database.session();

    const recipes = await session.query(Recipe).all();

    test.assertTrue('Basic reconstruction', (
        recipes.length == 1 && recipes[0].name == 'fish dinner'
    ));

    const fishDinner = recipes[0];

    const loadOp = fishDinner.ingredient_items.get();
    test.assertTrue('Lazy-loaded relationships are async', (
        loadOp instanceof Promise
    ));
    test.assertTrue('Async loads return sane value', (
        (await loadOp)[0] == fishDinner.ingredient_items.get()[0]
    ));

    await session.close();
};

module.exports = testReconstruction;
