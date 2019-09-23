# sago

[![CircleCI](https://circleci.com/gh/robinsax/sago/tree/master.svg?style=svg)](https://circleci.com/gh/robinsax/sago/tree/master)

sago is a mini-ORM for node & PostgreSQL. It's intended for web application development.

## At a glance

* Tiny and opinionated, like Angela from *The Office*.
* Zero needless dependencies; just `node-postgres`.
* Attactive, low character count usage code.
* Strictly typed and validated model attributes.
* Explicit relationship management.
* `async` if and only if SQL is being emitted.
* Easy serialization to, and deserialization from, JSON (with useful validation errors).

```javascript
const sago, { Model } = require('sago');

const database = sago('demo_db');

//  Model definitions.
@database.collection('recipes') // or database.register(Recipe).
class Recipe extends Model {
    schema = {
        id: ['uuid', {pk: true}],
        name: ['string', {length: 40}]
    };

    get ingredients() { return this.manyRelation(Ingredient); }
}

@database.collection('ingredients')
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
    const session = database.session();

    //  Ephemeral models? No problem.
    const breakfast = new Recipe({name: 'bacon and eggs'});
    
    //  Different coupling styles.
    const bacon = new Ingredient({name: 'bacon', quantity: 4});
    eggs.recipe.set(breakfast);
    const eggs = new Ingredient({name: 'eggs', quantity: 2, recipe: breakfast});

    //  All the relationship management you deserve.
    breakfast.ingredients.get(); // [eggs, bacon]

    //  Implicit models stored automatically.
    await session.add(breakfast);

    //  Relationship construction always happens in-database.
    eggs.recipe_id == breakfast.id; // true

    breakfast.name = 3; // Throws an AttributeTypeError.
    breakfast.name = new Array(41).fill('x'); // Throws an AttributeValueError.

    //  Super-powered batch updates from untrusted input. This throws a
    //  friendly (aggregate) error you can create a response from.
    const untrustedInput = {name: new Date(), id: 1};
    breakfast.update(untrustedInput);

    //  Deep serialization is easy.
    breakfast.serialize({include: ['ingredients']});

    //  Automatic attribute update management, of course.
    breakfast.name = 'simple bacon and eggs';
    //  ...and it's all transactional!
    await session.commit(); // Emits the above update.
})();
```
