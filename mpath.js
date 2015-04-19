var mongoose = require("mongoose");
var q = require("q");
var _ = require("underscore");

// Enable mpath structures on any `schema`.
var enable = module.exports.enable = function(schema) {
    schema.plugin(function() {
        schema.add({
            mpath:{
                type:String,
                index:true
            },
            parentId:{
                type:String,
                index:true
            }
        });
    });
}

// Attach `child` to `parent`.  Passing true in `isLeaf` improves performance for leaf nodes because no check needs
// to be done to rewrite the paths of child nodes.  When a `parent` is not passed, it implies the `child` is to be made
// a root.
var attach = module.exports.attach = function(child, parent, isLeaf) {
    var childPath;
    // Compute the mpath for the `child` node.  Is there is no `parent`, the mpath is empty, if the `parent` is a root, then
    // the mpath is equal to the `parent` id, otherwise it is the `parent` mpath plus it's id
    if (!parent) {
        childPath = "";
    }
    else if (!parent.mpath) {
        childPath = "/"+parent.id;
    }
    else {
        childPath = parent.mpath+"/"+parent.id;
    }
    // If the `child` is a leaf, just set the mpath, save it, and complete the promise
    if (isLeaf) {
        child.mpath = childPath;
        child.parentId = parent?parent.id:undefined;
        return q.ninvoke(child, "save").then(function() {
            return child;
        });

    }
    else {
        // If the `child` is not a leaf, then find all it's descendants and recompute their mpaths, but still return
        // the `child` once all the save promises are resolved.
        return getDescendants(child)
            .then(function(descendants) {
                var promises = descendants.map(function(descendant) {
                    descendant.mpath = descendant.mpath.replace(child.mpath, childPath);
                    return q.ninvoke(descendant, "save");
                });
                child.mpath = childPath;
                child.parentId = parent?parent.id:undefined;
                promises.push(q.ninvoke(child, "save"));
                return q.all(promises);
            })
            .then(function() {
                return child;
            });

    }
};

// Detach a `child` from it's parent.  This is done by simply "attaching" it to a undefined parent
var detach = module.exports.detach = function(child) {
    return attach(child);
};

// Make a copy of `root`, assigning the copy to the same parent.  Note that `root` does not actually need to be a root
// node, it is just the root of the tree of nodes that should be copied.
var copy = module.exports.copy = function(root, options) {
    var objects = [];
    // Convert the `node` to a deep POJO representing this tree.  This function is called recursively to process the
    // entire tree rooted at `node`
    function toDeepObject(node) {
        var copy;
        if (options.copy) {
            copy = options.copy(node);
        }
        else {
            copy = new node.constructor(node.toObject());
            copy._id = new mongoose.Types.ObjectId();
        }
        var object = copy.toObject();
        object.children = {};
        for (var id in node.children) {
            var child = node.children[id];
            if (options.filterChild(child)) {
                var childObject = toDeepObject(child);
                childObject.parent = object;
                object.children[id] = childObject;
            }
        }
        return object;
    }
    // Reset the parent id and mpaths of `object` and all it's child objects.  This method is intended to be called with
    // the output of toDeepObject
    function reId(object) {
        if (object.parent) {
            object.parentId = object.parent._id.toString();
            if (object.parent.mpath) {
                object.mpath = object.parent.mpath+"/"+object.parent._id.toString();
            }
            else {
                object.mpath = "/"+object.parent._id.toString();
            }
        }
        objects.push(object);
        for (var id in object.children) {
            reId(object.children[id]);
        }
    }
    // Start the promise chaining by getting the descendant tree of `root`
    return buildDescendantTree(root)
        .then(function(root) {
            // Convert `root` to a deep object and reset the parent id and mpath values
            reId(toDeepObject(root));
            // Delete the child and parent properties of the deep `object`.  Once parent id and mpath properties have
            // been computed, there is no further need to maintain the references, in fact they need to be removed
            // before bulk insert.
            objects.forEach(function(object) {
                delete object.children;
                delete object.parent;
            })
            // Bulk insert the `objects` using mongo's direct driver call.  This is efficient, but will not run any
            // middleware
            return q
                .ninvoke(root.constructor.collection, "insert", objects)
                .then(function(copies) {
                    return mongoose
                        .model(root.constructor.modelName)
                        .findOne(
                            {
                                _id:copies[0]._id.toString()
                            },
                            "")
                        .exec();
                })
                .then(function(rootCopy) {
                    return buildDescendantTree(rootCopy);
                })
        })
}

// Find all descendants of `root`.  This does not return a tree structure, just the nodes that would comprise such a tree
var getDescendants = module.exports.getDescendants = function(root, options) {
    options = options?options:{};
    var query = options.query?options.query:{};
    query.mpath = new RegExp("^"+(root.mpath?root.mpath:"")+"\/"+root.id);
    return root.constructor
        .find(query, options.fields?options.fields:"")
        .exec();
}

// Delete all descendants of `root`
var removeDescendants = module.exports.removeDescendants = function(root, options) {
    options = options?options:{};
    var query = options.query?options.query:{};
    query.mpath = new RegExp("^"+(root.mpath?root.mpath:"")+"\/"+root.id);
    return root.constructor
        .find(query)
        .remove()
        .exec();
}

// Get all children of `root`
var getChildren = module.exports.getChildren = function(root, options) {
    options = options?options:{};
    var query = options.query?options.query:{};
    query.parentId = root.id;
    return root.constructor
        .find(query, options.fields?options.fields:"")
        .exec();
}

// Given an array of `nodes`, construct the set of trees containing all the `nodes` such that the number of roots is
// minimized.  In the common case, this is used to convert the output of `getDescendants()` into a tree structure
var buildTrees = module.exports.buildTree = function(nodes) {
    var nodeMap = {};
    nodes.forEach(function(node) {
        nodeMap[node.id] = node;
        node.children = {};
    });
    nodes.forEach(function(node) {
        var parent = nodeMap[node.parentId];
        if (parent) {
            parent.children[node.id] = node;
            node.parent = parent;
        }
    });
    nodes.forEach(function(node) {
        if (node.parent) {
            delete nodeMap[node.id];
        }
    });
    return _.values(nodeMap);
}

// Get all descendants of `root` structured as a tree
var buildDescendantTree = module.exports.buildDescendantTree = function(root) {
    return getDescendants(root)
        .then(function(documents) {
            documents.push(root);
            buildTrees(documents);
            return root;
        })
}

// Get all children of `root` structured as a tree
var buildChildrenTree = module.exports.buildChildrenTree = function(root) {
    return getChildren(root)
        .then(function(documents) {
            documents.push(root);
            buildTrees(documents);
            return root;
        })
}

// Get all ancestors of all of the `documents` structured as a set of trees.  Note that the number of returned trees may
// be less than the number of passed `documents` because different child nodes may have common ancestors.  In a single root
// hierarchy (where all paths lead to the same root), this method will always return one tree.  If any of the `documents`
// have children, or descendants, integrate these into the overall ancestor tree, but do not include any children of
// any of the ancestors of the `documents`
var buildAncestorTree = module.exports.buildAncestorTree = function(documents) {
    var idSet = {};
    var descendants = [];
    if (!documents) {
        return [];
    }
    documents = [].concat(documents);
    if (documents.length==0) {
        return [];
    }
    function getDescendants(document) {
        if (document.children) {
            _.values(document.children).forEach(function(child) {
                descendants.push(child);
                getDescendants(child);
            })
        }
    }
    documents.forEach(function(document) {
        getDescendants(document);
        if (document.mpath) {
            document.mpath
                .split("/")
                .forEach(function(id) {
                    idSet[id] = true;
                });
        }
    })
    delete idSet[""];

    return documents[0].constructor
        .find({
            _id:{
                $in:_.keys(idSet)
            }
        })
        .exec()
        .then(function(ancestors) {
            documents = documents.concat(descendants);
            documents = documents.concat(ancestors);
            return buildTrees(documents);
        })
}
