const { AttributeTypeError, AttributeValueError } = require('sago');

const { IngredientType } = require('../model');

const testSingleModel = async (database, test) => {
    let session = database.session();

    const fish = new IngredientType({name: 'fish'});

    test.assertTrue('Attribute proxy sets', fish.name == 'fish');
    test.assertThrows('Attribute type enforced', AttributeTypeError, () => {
        fish.name = 2;
    });
    test.assertThrows('Attribute type enforced', AttributeTypeError, () => {
        fish.name = new Date();
    });
    test.assertThrows('Attribute format enforced', AttributeValueError, () => {
        fish.name = (new Array(2000)).join(' ');
    });

    session.add(fish);
    await session.commit({close: true});
    test.assertTrue('IDs assigned', fish.id);
    const fishId = fish.id;

    session = database.session();

    const loadedFish = await session.query(IngredientType).first();
    test.assertTrue('Reloading maintains ID', fishId == loadedFish.id);

    const otherFish = await session.query(IngredientType).where({
        name: 'fish'
    }).first();
    test.assertTrue('Simple model refreshes and queries', otherFish === loadedFish);

    loadedFish.name = null;
    await test.assertThrows('Nullability checked at commit time', AttributeValueError, () => (
        session.commit()
    ));

    const empty = await session.query(IngredientType).where({name: ['!=', 'fish']}).all();
    test.assertTrue('Empty query = empty list', empty.length === 0);

    session.delete(loadedFish);
    await session.commit({close: true});
};

module.exports = testSingleModel;
