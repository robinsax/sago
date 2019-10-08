const { Model } = require('sago');

class IngredientType extends Model {
    collection = 'ingredient_types';
    schema = {
        id: ['uuid', {pk: true}],
        name: ['string', {length: 40}]
    };

    get members() { return this.manyRelation(Ingredient, {order: {name: 'asc'}}); }
}

class Ingredient extends Model {
    collection = 'ingredients';
    schema = {
        id: ['uuid', {pk: true}],
        name: ['string', {length: 40}],
        type_id: ['uuid', {fk: 'ingredient_types.id', nullable: true}]
    };

    get type() { return this.oneRelation(IngredientType); }
}

class Recipe extends Model {
    collection = 'recipes';
    schema = {
        id: ['uuid', {pk: true}],
        name: ['string', {length: 40}],
        last_cooked_at: ['datetime', {default: 'now()', nullable: true}]
    };

    get ingredient_items() { return this.manyRelation(IngredientItem, {order: {quantity: 'desc'}}); }

    async cook() {
        this.last_cooked_at = new Date();

        const ingredientDescriptions = await this.ingredientItems.map(i => (
            i.describe()
        ));
        console.log(`cooking ${ this.name } with these ingredients: ${ ingredientDescriptions.join(',') }`);
        return this;
    }
}

class IngredientItem extends Model {
    collection = 'ingredient_items';
    schema = {
        id: ['uuid', {pk: true}],
        recipe_id: ['uuid', {fk: 'recipes.id'}],
        ingredient_id: ['uuid', {fk: 'ingredients.id'}],
        quantity: ['string', {length: 30}],
    };

    get recipe() { return this.oneRelation('recipes'); }
    get ingredient() { return this.oneRelation('ingredients'); }
}

module.exports = { IngredientType, Ingredient, Recipe, IngredientItem };
