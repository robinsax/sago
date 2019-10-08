const { AttributeTypeError, RelationalAttributeError, ModelStateError, AttributeValueError } = require('sago');

const { IngredientType, IngredientItem } = require('../model');

const testSingleModel = async (database, test) => {
    let session = database.session();

    const fish = new IngredientType({name: 'fish'});

    test.assertTrue('Attribute proxy sets', fish.name == 'fish');
    await test.assertThrows('Attribute type enforced', AttributeTypeError, () => {
        fish.name = 2;
    });
    await test.assertThrows('Attribute type enforced', AttributeTypeError, () => {
        fish.name = new Date();
    });
    await test.assertThrows('Attribute format enforced', AttributeValueError, () => {
        fish.name = (new Array(2000)).join(' ');
    });

    await session.add(fish);
    test.assertTrue('IDs assigned', fish.id);
    const fishId = fish.id;
    await session.commit();

    session = database.session();

    const loadedFish = await session.query(IngredientType).first();
    test.assertTrue('Reloading maintains ID', fishId == loadedFish.id);

    const otherFish = await session.query(IngredientType).where({
        name: 'fish'
    }).first();
    test.assertTrue('Simple model refreshes and queries', otherFish === loadedFish);

    const empty = await session.query(IngredientType).where({
        name: ['!=', 'fish']
    }).all();
    test.assertTrue('Empty query = empty list', empty.length === 0);

    const id = loadedFish.id;

    await loadedFish.members.get(); // We need to load many-side relations before delete for now.
    await session.delete(loadedFish);
    await test.assertThrows('Post-delete write lock', ModelStateError, () => {
        otherFish.name = 'cool';
    });

    await session.add(loadedFish);
    await test.assertNoError('Re-creation works', () => {
        otherFish.name = 'asd';
    });
    test.assertTrue('Re-creation maintains ID', id == otherFish.id);

    await session.delete(loadedFish);
    await session.commit();
};

module.exports = testSingleModel;
