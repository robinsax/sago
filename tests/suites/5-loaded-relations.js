const { ModelStateError, RelationalAttributeError } = require('sago');

const { Ingredient, IngredientType, Recipe, IngredientItem } = require('../model');

const testLoadedRelations = async (database, test) => {
    let session = database.session();

    let recipe = await session.query(Recipe).where({name: 'fish dinner'}).first();
    let twoSalmon = await session.query(IngredientItem).where({recipe_id: recipe.id}).first();

    await test.assertThrows('Unloaded relationship modification dies', ModelStateError, () => {
        recipe.ingredient_items.remove(twoSalmon);
    });

    await recipe.ingredient_items.get();
    test.assertTrue('Relations valid after many-side loading', (
        recipe.ingredient_items.get().length == 1 &&
        recipe.ingredient_items.get()[0] == twoSalmon &&
        twoSalmon.recipe.get() == recipe
    ));

    await test.assertThrows('De-coupling fails if it violates FK contraints', RelationalAttributeError, async () => {
        await recipe.ingredient_items.remove(twoSalmon);
    });
    await session.close();

    session = database.session();
    recipe = await session.query(Recipe).where({name: 'fish dinner'}).first();
    twoSalmon = await session.query(IngredientItem).where({recipe_id: recipe.id}).first();

    await recipe.ingredient_items.get();
    await session.delete(twoSalmon);
    test.assertTrue('De-coupling succeeds if a side effect of model deletion', (
        recipe.ingredient_items.get().length == 0
    ));

    await test.assertThrows('Recreating with invalid relationship dies', RelationalAttributeError, async () => {
        await session.add(twoSalmon);
    });

    await session.close();
    session = database.session();

    recipe = await session.query(Recipe).first();

    await test.assertThrows('Deletion with unloaded many-side fails', ModelStateError, async () => {
        await session.delete(recipe);
    });
};

module.exports = testLoadedRelations;
