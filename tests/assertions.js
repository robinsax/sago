class AssertionSet {
    constructor() {
        this.passed = 0;
        this.failed = 0;
        this.errored = 0;
    }

    pass() {
        console.log('  \x1b[32mpassed\x1b[0m');
        this.passed++;
    }

    fail() {
        console.log('  \x1b[33mfailed\x1b[0m');
        this.failed++;
    }

    error(ex) {
        console.log('  \x1b[31merrored\x1b[0m');
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

    assertThrows(name, ErrorClass, callable) {
        const handleErr = err => {
            if (err instanceof ErrorClass) this.pass();
            else this.error(err.stack);
        }

        console.log(name);
        try {
            const result = callable();
            if (result instanceof Promise) return result.then(() => this.fail(), handleErr);

            this.fail();
        }
        catch (ex) {
            handleErr(ex);
        }
    }

    assertReturns(name, returnValue, callable) {
        const checkRv = result => {
            if (result === returnValue) this.pass();
            else this.fail();
        }

        console.log(name);
        try {
            let result = callable();
            if (result instanceof Promise) return result.then(checkRv, ex => this.error(ex.stack));
            
            checkRv(result);
        }
        catch (ex) {
            this.error(ex.stack);
        }
    }

    assertNoError(name, callable) {
        console.log(name);
        try {
            const result = callable();
            if (result instanceof Promise) return result.then(() => this.pass(), ex => this.error(ex.stack));

            this.pass();
        }
        catch (ex) {
            this.error(ex.stack);
        }
    }

    report() {
        console.log(`\x1b[32m${ this.passed } passed\x1b[0m | \x1b[33m${ this.failed } failed\x1b[0m | \x1b[31m${ this.errored } errored\x1b[0m`);
    }
}

module.exports = { AssertionSet };
