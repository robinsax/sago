# sago

[![CircleCI](https://circleci.com/gh/robinsax/sago/tree/master.svg?style=svg)](https://circleci.com/gh/robinsax/sago/tree/master) [![Coverage Status](https://coveralls.io/repos/github/robinsax/sago/badge.svg?branch=master)](https://coveralls.io/github/robinsax/sago?branch=master)

sago is a mini-ORM for node & PostgreSQL. It's intended for web application development.

## At a glance

* Tiny and opinionated, like Angela from *The Office*.
* Zero needless dependencies; just `node-postgres`.
* Attactive, low character count usage code.
* Strictly typed and validated model attributes.
* Explicit relationship management.
* Rarely and predictably `async`.
* Easy serialization to, and deserialization from, JSON (with useful validation errors).

```javascript
const sago = require('sago');

const { Model, session, collection } = sago('demo_db');

//  Model definitions.
@collection('recipes') // or database.register(Recipe).
class Recipe extends Model {
    schema = {
        id: ['uuid', {pk: true}],
        name: ['string', {length: 40}]
    };

    get ingredients() { return this.manyRelation(Ingredient); }
}

@collection('ingredients')
class Ingredient extends Model {
    schema = {
        id: ['uuid', {pk: true}],
        recipe_id: ['uuid', {fk: 'recipes.id'}],
        name: ['string', {length: 40}],
        quantity: 'int'
    }

    get recipe() { return this.oneRelation(Recipe); }
}

//  Usage.
(async () => {
    const sess = session();

    //  Easy to use models? No problem.
    const breakfast = new Recipe({name: 'bacon and eggs'});
    
    //  Explicit relationship management and different coupling styles.
    const bacon = new Ingredient({name: 'bacon', quantity: 4});
    bacon.recipe.set(breakfast); // OR breakfast.ingredients.push(bacon);
    const eggs = new Ingredient({name: 'eggs', quantity: 2, recipe: breakfast});
    
    //  All the relationship management you deserve.
    breakfast.ingredients.get(); // [eggs, bacon]

    //  Related models stored automatically.
    await sess.add(breakfast).commit();

    //  Relationship construction always happens in-database.
    eggs.recipe_id == breakfast.id; // true

    breakfast.name = 3; // Throws an AttributeTypeError.
    breakfast.name = new Array(41).fill('x').join(''); // Throws an AttributeValueError.

    const untrustedInput = {name: new Date(), id: 1};
    //  Batch operations from untrusted input. These throw friendly aggregated errors.
    breakfast.update(untrustedInput);
    new Recipe(untrustedInput);

    //  Deep serialization is easy.
    breakfast.serialize({include: ['ingredients']});

    //  Automatic attribute update management, of course.
    breakfast.name = 'simple bacon and eggs';
    //  ...and it's all transactional.
    await session.commit();
})();
```
