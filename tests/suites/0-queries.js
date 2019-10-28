const { IngredientType } = require('../model');
const { NativeQueryError, QueryError, AttributeError } = require('sago');

const testQueries = async (database, test) => {
    const session = database.session();

    await test.assertThrows('SQL emission errors are caught', QueryError, () => (
        session._emit('fjkasdkjf;')
    ));

    await test.assertThrows('Invalid query dies (insert)', QueryError, () => (
        session.query(IngredientType).insert(null)
    ));
    await test.assertThrows('Invalid query dies (update)', QueryError, () => (
        session.query(IngredientType).update(null)
    ));
    await test.assertThrows('Invalid query dies (update with invalid value)', AttributeError, () => (
        session.query(IngredientType).update({id: 1})
    ));
    await test.assertThrows('Invalid query dies (update with limit)', QueryError, () => (
        session.query(IngredientType).limit(1).update({name: 'a'})
    ));

    const {id} = await session.query(IngredientType).return(['id']).insert({name: 'a'});
    test.assertTrue('Insertion works', id);

    await test.assertNoError('Update runs without error', () => (
        session.query(IngredientType).where({name: ['!=', 'b']}).update({name: 'b'})
    ));

    const {name} = await session.query(IngredientType).return('name').where({name: ['<', 'c']}).first();
    test.assertTrue('Update works', name == 'b');

    const {0: {id: deletedId}} = await session.query(IngredientType).return([
        IngredientType.attributes.id
    ]).where({id}).delete();
    test.assertTrue('Deletion return works', id == deletedId);
};

module.exports = testQueries;
