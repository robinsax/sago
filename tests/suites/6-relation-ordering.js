const { IngredientType, Ingredient, Recipe, IngredientItem } = require('../model');

const testRelationOrdering = async (database, test) => {
    const vegetable = new IngredientType({name: 'vegetable'}),
        brocolli = new Ingredient({name: 'brocolli', type: vegetable}),
        radish = new Ingredient({name: 'radish', type: vegetable}),
        arugula = new Ingredient({name: 'arugula', type: vegetable}),
        gardenSalad = new Recipe({name: 'garden salad'}),
        twoBrocolli = new IngredientItem({quantity: 'two', ingredient: brocolli, recipe: gardenSalad}),
        aRadish = new IngredientItem({quantity: 'one', ingredient: radish, recipe: gardenSalad}),
        sixArugula = new IngredientItem({quantity: 'six', ingredient: arugula, recipe: gardenSalad});

    const session = database.session();

    session.add(gardenSalad);
    await session.commit();

    const checkOrder = (source, expect) => source.filter((o, i) => (
        o == expect[i]
    )).length == source.length;

    test.assertTrue('Creation is okay', (
        vegetable.id && brocolli.id && radish.id && arugula.id &&
        gardenSalad.id && twoBrocolli.id && aRadish.id && sixArugula.id
    ));
    test.assertTrue('Asc. relation order is correct after creation', checkOrder(vegetable.members.get(), [
        arugula, brocolli, radish
    ]));
    gardenSalad.ingredient_items.get();
    test.assertTrue('Desc. relation order is correct after creation', checkOrder(gardenSalad.ingredient_items.get(), [
        twoBrocolli, sixArugula, aRadish
    ]));

    const nothing = new IngredientItem({quantity: 'zero', ingredient: brocolli, recipe: gardenSalad});

    session.add(nothing);

    test.assertTrue('Desc. re-order correct', checkOrder(gardenSalad.ingredient_items.get(), [
        nothing, twoBrocolli, sixArugula, aRadish
    ]));
};

module.exports = testRelationOrdering;
