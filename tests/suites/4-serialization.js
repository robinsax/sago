const { AttributeErrors } = require('sago');
const { Recipe } = require('../model');

const testSerialization = async (database, test) => {
    const session = database.session();

    const fishDinner = await session.query(Recipe).where({name: 'fish dinner'}).first();

    let json = null;
    await test.assertNoError('Synchronous direct serialization runs', () => {
        json = fishDinner.serialize({string: true});
    });
    
    test.assertTrue('Cosmetic serialized output check', json.startsWith('{"id":'));

    await test.assertNoError('Asynchronous serialization runs', async () => {
        await fishDinner.serialize({async: true, include: [
            ['ingredient_items', {
                include: [
                    ['ingredient', {include: ['type']}]
                ]
            }]
        ]});
    });

    await test.assertThrows('Bulk update throws attribute errors', AttributeErrors, () => {
        fishDinner.update({id: new Date()});
    });

    const mark = new Date().toISOString();
    fishDinner.update({last_cooked_at: mark}, true);
    test.assertTrue('Bulk serialized update succeeds', fishDinner.last_cooked_at.toISOString() == mark);

    await session.close();
};

module.exports = testSerialization;
