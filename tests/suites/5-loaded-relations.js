const { ModelStateError, RelationalAttributeError } = require('sago');

const { Ingredient, IngredientType, Recipe, IngredientItem } = require('../model');

const testLoadedRelations = async (database, test) => {
    let session = database.session();

    let recipe = await session.query(Recipe).where({name: 'fish dinner'}).first();
    let twoSalmon = await session.query(IngredientItem).where({recipe_id: recipe.id}).first();

    test.assertThrows('Unloaded relationship modification dies', ModelStateError, () => {
        recipe.ingredient_items.remove(twoSalmon);
    });

    await recipe.ingredient_items.get();
    test.assertTrue('Relations valid after many-side loading', (
        recipe.ingredient_items.get().length == 1 &&
        recipe.ingredient_items.get()[0] == twoSalmon &&
        twoSalmon.recipe.get() == recipe
    ));

    session.delete(twoSalmon);
    test.assertTrue('De-coupling succeeds if a side effect of model deletion', (
        recipe.ingredient_items.get().length == 0
    ));

    const otherRecipe = new Recipe({name: 'salmon burgers'});
    otherRecipe.ingredient_items.push(twoSalmon);

    test.assertTrue('Many-side entry into relationship causes previous relationship unlink', (
        recipe.ingredient_items.get().length == 0
    ));

    await session.close();
};

module.exports = testLoadedRelations;
