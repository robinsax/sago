const { AttributeErrors } = require('sago');
const { Recipe, Ingredient, IngredientItem } = require('../model');

const testSerialization = async (database, test) => {
    const session = database.session();

    const fishDinner = await session.query(Recipe).where({name: 'fish dinner'}).first();

    const onion = new Ingredient({name: 'onion'});
    const halfOnion = new IngredientItem({quantity: 'one half', ingredient: onion, recipe: fishDinner});

    session.add(halfOnion);
    
    let json = null;
    test.assertNoError('Synchronous direct serialization runs', () => {
        json = fishDinner.serialize({string: true});
    });
    test.assertTrue('Cosmetic serialized output check', json.startsWith('{"id":'));

    let serialized = null;
    await test.assertNoError('Asynchronous serialization runs', async () => {
        serialized = await fishDinner.serialize({async: true, include: [
            ['ingredient_items', {
                include: [
                    ['ingredient', {include: ['type']}]
                ]
            }]
        ]});
    });
    test.assertTrue('Serialization has good shape', (
        serialized && serialized.ingredient_items instanceof Array &&
        serialized.ingredient_items[1].ingredient &&
        serialized.ingredient_items[1].ingredient.type &&
        serialized.ingredient_items[0].ingredient.type === null
    ));

    test.assertThrows('Bulk update throws attribute errors', AttributeErrors, () => {
        fishDinner.update({id: new Date()});
    });

    const mark = new Date().toISOString();
    fishDinner.update({last_cooked_at: mark}, true);
    test.assertTrue('Bulk serialized update succeeds', fishDinner.last_cooked_at.toISOString() == mark);

    await session.close();
};

module.exports = testSerialization;
