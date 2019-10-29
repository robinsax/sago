const { RelationalAttributeError } = require('sago');

const { IngredientType, Ingredient, IngredientItem, Recipe } = require('../model');

const testEphemeralRelations = async (database, test) => {
    const fish = new IngredientType({name: 'fish'});
    const trout = new Ingredient({name: 'trout'});

    session = database.session();

    trout.type.set(fish);

    test.assertTrue('Local assignment to one-side proxy', trout.type.get() == fish);

    test.assertTrue('Remote value after assignment to one-side proxy', (
        !(fish.members.get() instanceof Promise) &&
        fish.members.get().length === 1 &&
        fish.members.get()[0] == trout
    ));

    trout.type.set(null);

    test.assertTrue('Local clear of one-side proxy', trout.type.get() === null);

    test.assertTrue('Remote value after clear of one-side proxy', fish.members.get().length === 0);

    fish.members.push(trout);

    test.assertTrue('Local assignment of many-side proxy', (
        fish.members.get().length == 1 && fish.members.get()[0] == trout
    ));

    test.assertTrue('Remote value after assignment to many-side proxy', trout.type.get() == fish);

    fish.members.remove(trout);

    test.assertTrue('Local clear of many-side proxy', fish.members.get().length === 0);

    test.assertTrue('Remote value after clear of many-side proxy', trout.type.get() === null);

    trout.type.set(fish);

    const salmon = new Ingredient({name: 'salmon', type: fish});

    test.assertTrue('Constructor coupling of ephemeral models', salmon.type.get() == fish);

    test.assertTrue('In-memory sorting of many-side proxies', fish.members.get()[0] == salmon);

    const fishDinner = new Recipe({name: 'fish dinner'});

    const twoSalmon = new IngredientItem({quantity: '2 whole fish', recipe: fishDinner, ingredient: salmon});

    test.assertNoError("Valid deep relationship write from top node doesn't error", () => {
        session.add(twoSalmon);
    });

    await session.commit();

    test.assertTrue('Deep relationship write assigns IDs and FKs', (
        fishDinner.id && twoSalmon.recipe_id == fishDinner.id &&
        salmon.id && twoSalmon.ingredient_id == salmon.id &&
        fish.id && salmon.type_id == fish.id
    ));

    const salad = new Recipe({name: 'salad'});
    const twoTomatoes = new IngredientItem({quantity: '2', recipe: salad});

    session.add(twoTomatoes);
    await test.assertThrows('Invalid deep relationship write from top node errors', RelationalAttributeError, () => (
        session.commit()
    ));

    await session.close();
};

module.exports = testEphemeralRelations;
