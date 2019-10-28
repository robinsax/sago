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

    recipe.ingredient_items.push(twoSalmon);
    test.assertTrue('Re-coupling via proxy works', (
        recipe.ingredient_items.get().length == 1 &&
        twoSalmon.recipe.get() == recipe
    ));

    recipe.ingredient_items.remove(twoSalmon);
    test.assertTrue('De-coupling via many-side updates both sides', (
        twoSalmon.recipe.get() === null &&
        recipe.ingredient_items.get().length == 0
    ));

    twoSalmon.recipe_id = recipe.id;
    test.assertTrue('Coupling via FK updates both sides', (
        twoSalmon.recipe.get() === recipe &&
        recipe.ingredient_items.get()[0] == twoSalmon
    ));

    twoSalmon.recipe_id = null;
    test.assertTrue('De-coupling via FK updates both sides', (
        twoSalmon.recipe.get() === null &&
        recipe.ingredient_items.get().length == 0
    ));

    recipe.ingredient_items.push(twoSalmon);

    const otherRecipe = new Recipe({name: 'salmon burgers'});
    otherRecipe.ingredient_items.push(twoSalmon);

    test.assertTrue('Many-side entry into relationship causes previous relationship unlink', (
        recipe.ingredient_items.get().length == 0
    ));

    const salmon = await session.query(Ingredient).where({name: 'salmon'}).first();
    twoSalmon.ingredient.set(salmon);
    session.add(otherRecipe);
    session.delete(otherRecipe);
    test.assertTrue('Ephemeral many-side deletion updates bound one-side', (
        twoSalmon.recipe.get() == null
    ));

    await session.close();

    session = database.session();

    recipe = await session.query(Recipe).where({name: 'fish dinner'}).first();
    twoSalmon = await session.query(IngredientItem).where({recipe_id: recipe.id}).first();

    const anotherFish = new IngredientItem({quantity: 'another', recipe, ingredient: await twoSalmon.ingredient.get()});

    test.assertTrue('Row-bound relation to loaded many-side resolved on query', (
        twoSalmon.recipe.get() === recipe
    ));
    test.assertTrue('Ephemeral relation formed on one-side', (
        anotherFish.recipe.get() == recipe
    ));

    session.delete(recipe);
    test.assertTrue('Many-side deletion updates one-side across unloaded relationship', (
        twoSalmon.recipe.get() == null && anotherFish.recipe.get() == null
    ));

    test.assertThrows('Commiting with invalid relationships dies', RelationalAttributeError, () => (
        session.commit()
    ));
};

module.exports = testLoadedRelations;
