class AssertionSet {
    constructor() {
        this.passed = 0;
        this.failed = 0;
        this.errored = 0;
    }

    pass() {
        console.log('  passed');
        this.passed++;
    }

    fail() {
        console.log('  failed');
        this.failed++;
    }

    error(ex) {
        console.log('  error!');
        console.log([
            '\t########',
            '\t' + (ex + '').split('\n').join('\n\t'),
            '\t########'
        ].join('\n'))
        this.errored++;
    }

    assertTrue(name, cond) {
        console.log(name);

        if (cond) this.pass();
        else this.fail();
    }

    async assertThrows(name, ErrorClass, callable) {
        console.log(name);
        try {
            const result = callable();
            if (result instanceof Promise) await result;

            this.fail();
        }
        catch (ex) {
            if (ex instanceof ErrorClass) this.pass();
            else this.error(ex.stack);
        }
    }

    async assertReturns(name, returnValue, callable) {
        console.log(name);
        try {
            let result = callable();
            if (result instanceof Promise) result = await result;

            if (result === returnValue) this.pass();
            else this.fail();
        }
        catch (ex) {
            this.error(ex.stack);
        }
    }

    async assertNoError(name, callable) {
        console.log(name);
        try {
            await callable();
            this.pass();
        }
        catch (ex) {
            this.error(ex.stack);
        }
    }

    report() {
        console.log(`${ this.passed } passed | ${ this.failed } failed | ${ this.errored } errored`);
    }
}

module.exports = { AssertionSet };
