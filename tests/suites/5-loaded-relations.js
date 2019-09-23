const { Ingredient, IngredientType, Recipe, IngredientItem } = require('../model');

const testLoadedRelations = async (database, test) => {
    const session = database.session();

    const recipe = await session.query(Recipe).where({name: 'fish dinner'}).first();
};

module.exports = testLoadedRelations;
