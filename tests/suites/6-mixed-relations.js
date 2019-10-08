const { Ingredient, IngredientType } = require('../model');

const testMixedRelations = async (database, test) => {
    let session = database.session();

    const vegetable = new IngredientType({name: 'vegetable'});
    const brocolli = new Ingredient({name: 'brocolli'});

    const checkState = () => (
        vegetable.id && brocolli.id && brocolli.type_id == vegetable.id &&
        vegetable.members.get()[0] == brocolli && brocolli.type.get() == vegetable
    );

    const oneBindWithCheck = async () => {
        const rv = brocolli.type.set(vegetable);
        test.assertTrue('Operation is asynchronous', rv instanceof Promise);
        await rv;
    };

    const manyBindWithCheck = async () => {
        const rv = vegetable.members.push(brocolli);
        test.assertTrue('Operation is asynchronous', rv instanceof Promise);
        await rv;
    };

    console.log('# One-side set with many-side bound.');
    await session.add(vegetable);
    
    await oneBindWithCheck();

    await session.commit();
    test.assertTrue('One-side mixed relation resolves properly (many-side is bound)', checkState());
    await session.begin();    

    await session.delete(vegetable, brocolli);
    await session.commit();

    console.log('# One-side set with one-side bound.');
    await session.begin();
    await session.add(brocolli);

    await oneBindWithCheck();

    await session.commit();
    test.assertTrue('One-side mixed relation resolves properly (one-side is bound)', checkState());
    await session.begin();
    
    await session.delete(brocolli, vegetable);
    await session.commit();

    console.log('# Many-side set with one-side bound.');
    await session.begin();
    await session.add(brocolli);

    await manyBindWithCheck();

    await session.commit();
    test.assertTrue('One-side mixed relation resolves properly (one-side is bound)', checkState());
    await session.begin();
    
    await session.delete(brocolli, vegetable);
    await session.commit();

    console.log('# Many-side set with many-side bound.');
    await session.begin();
    await session.add(vegetable);

    await manyBindWithCheck();

    await session.commit();
    test.assertTrue('Many-side mixed relation resolves properly (many-side is bound)', checkState());
    await session.begin();
    
    await session.delete(brocolli, vegetable);
    await session.commit();
};

module.exports = testMixedRelations;
