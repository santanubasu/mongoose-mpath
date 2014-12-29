var q = require("q");
var mongoose = require("mongoose");
var mockgoose = require("mockgoose");
var _ = require("underscore");
var mpath = require("../mpath.js");

mockgoose(mongoose);

var nodeSchema = mongoose.Schema({
    name:String
});

mpath.enable(nodeSchema, "Node");

var Node = mongoose.model("Node", nodeSchema);

describe("For mpath module,", function() {
    before(function() {
        mongoose.connect("mongodb://localhost/testmpath");
    });
    beforeEach(function() {
        mongoose.connection.db.dropDatabase();
    });
    after(function() {
        mongoose.connection.close();
    })
    describe("tests attachment,", function() {
        var N1 = Node({
            name:"Node 1"
        });
        var N2 = Node({
            name:"Node 2"
        });
        var N3 = Node({
            name:"Node 3"
        });
        var N4 = Node({
            name:"Node 4"
        });
        before(function() {
            return q
                .all([
                    mpath.attach(N4, N2),
                    mpath.attach(N3, N2),
                    mpath.attach(N2, N1)
                ])
        });
        it("should return an array containing child when a root parent is passed", function(done) {
            mpath
                .getChildren(N1)
                .then(function(children) {
                    _.findWhere(children, {id:N2.id})?done():done(new Error());
                });
        });
        it("should return an array containing children when a non root parent is passed", function(done) {
            mpath
                .getChildren(N2)
                .then(function(children) {
                    (_.findWhere(children, {id:N4.id})&&_.findWhere(children, {id:N3.id}))?done():done(new Error());
                });
        });
        it("should return an array not containing descendants when an ancestor is passed", function(done) {
            mpath
                .getChildren(N1)
                .then(function(children) {
                    (_.findWhere(children, {id:N4.id})||_.findWhere(children, {id:N3.id}))?done(new Error()):done();
                });
        });
    });
})