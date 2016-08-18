/**
 * Created by lilach.maliniak on 15/08/2016.
 */

var proxyquire = require('proxyquire');
var chai = require('chai');
var expect = chai.expect;
var sinon = require('sinon');
var Q = require('Q');
var should = chai.should();
var ControllerCtor = require('./../../lib/Controller');
var util=require('util');
var _ = require('underscore');

//var target = grunt.option('regression-tests');

//todo: in order for this to work need add to Controller, support in events.
describe('Regression test without HLS data analysis', function() {

    // Set an appropriate test timeout here to 12 hours: 12 * 3600 * 1000 = 43200000
    this.timeout(43200000);

    it('should run regression and receive same result as ground truth', function(done) {
        var controller = new ControllerCtor('');
        controller.on('exit', function(code) {
            if (code === 0) {
                // regression passed successfully
                console.log('*************************************************');
                console.log('*     regression test finished successfully     *');
                console.log('*************************************************');
            } else {
                // regression failed!
                console.log('*************************************************');
                console.log(util.format('@@@ regression test failed with error %s!!! @@@', code));
                console.log('*************************************************');
            }
            expect(code).to.equal(0);

            var argv = process.argv;
            var count = 0;
            console.log('===========================================================');
            console.log('|The list of command line arguments:                      |');
            console.log('===========================================================');
            _.each(process.argv, (arg) => {
                console.log(util.format('(%s) %s', ++count, arg));
            });
            console.log('===========================================================');            
            done();
        });
        controller.start();
    });
});
