console.log('Cloud code connected');

const Mailgun = require('mailgun-js');

const config = require('../configs/chisel.json');
const mailgunConfig = require('../chisel.js').mailgunConfig;

let mailgun = new Mailgun(mailgunConfig);


const SERVER = 'http://localhost:1337';

const ROLE_ADMIN = "ADMIN";
const ROLE_EDITOR = "EDITOR";


let promisify = pp => {
  return new Promise((rs, rj) => pp.then(rs, rj));
};

let promisifyW = pp => {
  return new Promise((rs, rj) => pp.then(rs, rs));
};

let checkRights = (user, obj) => {
  let acl = obj.getACL();
  if (!acl)
    return true;
  
  let read = acl.getReadAccess(user.id);
  let write = acl.getWriteAccess(user.id);
  
  let pRead = acl.getPublicReadAccess();
  let pWrite = acl.getPublicWriteAccess();
  
  return read && write || pRead && pWrite;
};

let getAllObjects = query => {
  const MAX_COUNT = 50;
  let objects = [];
  
  let getObjects = offset => {
    return promisify(query
      .limit(MAX_COUNT)
      .skip(offset)
      .find()
    )
      .then(res => {
        if (!res.length)
          return objects;
        
        objects = objects.concat(res);
        return getObjects(offset + MAX_COUNT);
      })
  };
  
  return getObjects(0);
};

let getTableData = table => {
  let endpoint = '/parse/schemas/' + table;
  
  return new Promise((resolve, reject) => {
    Parse.Cloud.httpRequest({
      url: SERVER + endpoint,
      method: 'GET',
      mode: 'cors',
      cache: 'no-cache',
      headers: {
        'Content-Type': 'application/json',
        'X-Parse-Application-Id': config.appId,
        'X-Parse-Master-Key': config.masterKey
      }
    })
      .then(response => {
        if (response.status == 200)
          resolve(response.data);
        else
          resolve(null);
      }, () => resolve(null));
  });
};

let setTableData = (table, data, method = 'POST') => {
  let endpoint = '/parse/schemas/' + table;
  
  return new Promise((resolve, reject) => {
    Parse.Cloud.httpRequest({
      url: SERVER + endpoint,
      method,
      mode: 'cors',
      cache: 'no-cache',
      headers: {
        'Content-Type': 'application/json',
        'X-Parse-Application-Id': config.appId,
        'X-Parse-Master-Key': config.masterKey
      },
      body: JSON.stringify(data)
    })
      .then(response => {
        if (response.status == 200)
          resolve();
        else
          reject();
      }, reject);
  });
};

let deleteTable = table => {
  let endpoint = '/parse/schemas/' + table;
  
  return new Promise((resolve, reject) => {
    Parse.Cloud.httpRequest({
      url: SERVER + endpoint,
      method: 'DELETE',
      mode: 'cors',
      cache: 'no-cache',
      headers: {
        'Content-Type': 'application/json',
        'X-Parse-Application-Id': config.appId,
        'X-Parse-Master-Key': config.masterKey
      }
    })
      .then(response => {
        if (response.status == 200)
          resolve();
        else
          reject();
      }, reject);
  });
};

let deleteContentItem = (user, tableName, itemId) => {
  let item;
  
  return promisify(
    new Parse.Query(tableName)
      .get(itemId)
  )
    .then(p_item => {
      item = p_item;
      
      if (!checkRights(user, item))
        return Promise.reject("Access denied!");
      
      return getTableData(tableName);
    })
    
    .then(data => {
      for (let field in data.fields) {
        let val = data.fields[field];
        if (val.type == 'Pointer' && val.targetClass == 'MediaItem') {
          let media = item.get(field);
          //!! uncontrolled async operation
          if (media)
            media.destroy();
        }
      }
    })
    
    .then(() => promisify(item.destroy()));
};

let deleteModel = (user, model) => {
  if (!checkRights(user, model))
    return Promise.reject("Access denied!");
  
  let tableName;
  
  return getAllObjects(
    new Parse.Query('ModelField')
      .equalTo('model', model)
  )
    .then(fields => {
      let promises = [];
      for (let field of fields) {
        if (checkRights(user, field))
          promises.push(promisifyW(field.destroy()));
      }
    
      return Promise.all(promises);
    })
    
    .catch(() => Promise.resolve())
  
    .then(() => {
      tableName = model.get('tableName');
      return getAllObjects(
        new Parse.Query(tableName));
    })
  
    .then(items => {
      let promises = [];
      for (let item of items) {
        promises.push(
          promisifyW(
            deleteContentItem(user, tableName, item.id)
          ));
      }
    
      return Promise.all(promises);
    })
  
    .catch(() => Promise.resolve())
  
    .then(() => deleteTable(tableName))
  
    .catch(() => Promise.resolve())
  
    .then(() => promisify(model.destroy()));
};


Parse.Cloud.define("deleteContentItem", (request, response) => {
  if (!request.user) {
    response.error("Must be signed in to call this Cloud Function.");
    return;
  }
  
  Parse.Cloud.useMasterKey();
  
  deleteContentItem(
    request.user,
    request.params.tableName,
    request.params.itemId
  )
    .then(() => response.success("Successfully deleted content item."))
    .catch(error => response.error("Could not delete content item: " + JSON.stringify(error, null, 2)));
});

Parse.Cloud.define("deleteModel", (request, response) => {
  if (!request.user) {
    response.error("Must be signed in to call this Cloud Function.");
    return;
  }
  
  Parse.Cloud.useMasterKey();
  
  promisify(
    new Parse.Query("Model")
      .get(request.params.modelId)
  )
    .then(model => deleteModel(request.user, model))
    
    .then(() => response.success("Successfully deleted model."))
  
    .catch(error => response.error("Could not delete model: " + JSON.stringify(error, null, 2)));
});


Parse.Cloud.define("deleteSite", (request, response) => {
  if (!request.user) {
    response.error("Must be signed in to call this Cloud Function.");
    return;
  }
  
  Parse.Cloud.useMasterKey();
  
  let site;
  
  promisify(
    new Parse.Query("Site")
      .get(request.params.siteId)
  )
    .then(p_site => {
      site = p_site;
      
      if (!checkRights(request.user, site))
        return Promise.reject("Access denied!");
      
      return getAllObjects(
        new Parse.Query('Model')
          .equalTo('site', site));
    })
    
    .then(models => {
      let promises = [];
      for (let model of models)
        promises.push(promisifyW(deleteModel(request.user, model)));
      
      return promises;
    })
    
    .then(() => {
      return getAllObjects(
        new Parse.Query('Collaboration')
          .equalTo('site', site));
    })
  
    .then(collabs => {
      let promises = [];
      for (let collab of collabs) {
        if (checkRights(request.user, collab))
          promises.push(promisifyW(collab.destroy()));
      }
  
      return Promise.all(promises);
    })
  
    //.catch(() => Promise.resolve())
    
    .then(() => promisify(site.destroy()))
  
    .then(() => response.success("Successfully deleted site."))
  
    .catch(error => response.error("Could not delete site: " + JSON.stringify(error, null, 2)));
});



Parse.Cloud.define("onCollaborationModify", (request, response) => {
  if (!request.user) {
    response.error('You must be authorized!');
    return;
  }
   
  Parse.Cloud.useMasterKey();
  
  let deleting = request.params.deleting;
  
  let collab, site, user, role, owner, collabACL;
  
  promisify(
    new Parse.Query("Collaboration")
      .get(request.params.collabId)
  )
    .then(p_collab => {
      collab = p_collab;
  
      if (!checkRights(request.user, collab))
        return Promise.reject("Access denied!");
      
      site = collab.get('site');
      user = collab.get('user');
      role = collab.get('role');
      
      return promisify(site.fetch());
    })
  
    .then(() => {
      //ACL for collaborations
      owner = site.get('owner');
      
      collabACL = collab.getACL();
      if (!collabACL)
        collabACL = new Parse.ACL(owner);
      
      //getting all site collabs
      return getAllObjects(
        new Parse.Query('Collaboration')
          .equalTo('site', site));
    })
    
    .then(collabs => {
      for (let tempCollab of collabs) {
        //set ACL for others collab
        let tempCollabACL = tempCollab.getACL();
        if (!tempCollabACL)
          tempCollabACL = new Parse.ACL(owner);
  
        let tempUser = tempCollab.get('user');
        if (tempUser == user)
          continue;
    
        tempCollabACL.setReadAccess(user, !deleting && role == ROLE_ADMIN);
        tempCollabACL.setWriteAccess(user, !deleting && role == ROLE_ADMIN);
    
        tempCollab.setACL(tempCollabACL);
        //!! uncontrolled async operation
        tempCollab.save();
    
        //set ACL for current collab
        if (!deleting) {
          let tempRole = tempCollab.get('role');
          collabACL.setReadAccess(tempUser, tempRole == ROLE_ADMIN);
          collabACL.setWriteAccess(tempUser, tempRole == ROLE_ADMIN);
        }
      }
  
      collabACL.setReadAccess(user, true);
      collabACL.setWriteAccess(user, true);
      collab.setACL(collabACL);
      //!! uncontrolled async operation
      collab.save();
    })
    
    .then(() => {
      //ACL for site
      let siteACL = site.getACL();
      if (!siteACL)
        siteACL = new Parse.ACL(owner);
  
      siteACL.setReadAccess(user, !deleting);
      siteACL.setWriteAccess(user, !deleting && role == ROLE_ADMIN);
      site.setACL(siteACL);
      //!! uncontrolled async operation
      site.save();
  
      //ACL for models and content items
  
      return getAllObjects(
        new Parse.Query('Model')
          .equalTo('site', site));
    })
    
    .then(models => {
      for (let model of models) {
        let modelACL = model.getACL();
        if (!modelACL)
          modelACL = new Parse.ACL(owner);
    
        modelACL.setReadAccess(user, !deleting);
        modelACL.setWriteAccess(user, !deleting && role == ROLE_ADMIN);
        model.setACL(modelACL);
        //!! uncontrolled async operation
        model.save();
    
        let tableName = model.get('tableName');
        //!! uncontrolled async operation
        getTableData(tableName)
          .then(response => {
            let CLP = response.classLevelPermissions;
            if (!CLP)
              CLP = {
                'get': {},
                'find': {},
                'create': {},
                'update': {},
                'delete': {},
                'addField': {}
              };
            
            if (!deleting) {
              CLP['get'][user.id] = true;
              CLP['find'][user.id] = true;
            } else {
              if (CLP['get'].hasOwnProperty(user.id))
                delete CLP['get'][user.id];
              if (CLP['find'].hasOwnProperty(user.id))
                delete CLP['find'][user.id];
            }
  
            if (!deleting && (role == ROLE_ADMIN || role == ROLE_EDITOR)) {
              CLP['create'][user.id] = true;
              CLP['update'][user.id] = true;
              CLP['delete'][user.id] = true;
            } else {
              if (CLP['create'].hasOwnProperty(user.id))
                delete CLP['create'][user.id];
              if (CLP['update'].hasOwnProperty(user.id))
                delete CLP['update'][user.id];
              if (CLP['delete'].hasOwnProperty(user.id))
                delete CLP['delete'][user.id];
            }
            
            if (!deleting && role == ROLE_ADMIN)
              CLP['addField'][user.id] = true;
            else if (CLP['addField'].hasOwnProperty(user.id))
              delete CLP['addField'][user.id];
  
            //!! uncontrolled async operation
            let data = {"classLevelPermissions": CLP};
            setTableData(tableName, data)
              .catch(() => setTableData(tableName, data, 'PUT'));
          });
      }
    })
    
    .then(() => response.success('ACL setup ends!'))
    
    .catch(e => response.error(e));
});


Parse.Cloud.define("onModelAdd", (request, response) => {
  if (!request.user) {
    response.error('You must be authorized!');
    return;
  }
  
  Parse.Cloud.useMasterKey();
  
  let model, site, owner, modelACL;
  
  promisify(
    new Parse.Query("Model")
      .get(request.params.modelId)
  )
    .then(p_model => {
      model = p_model;
      
      site = model.get('site');
      return promisify(site.fetch());
    })
    
    .then(() => {
      //ACL for collaborations
      owner = site.get('owner');
      modelACL = new Parse.ACL(owner);
      
      return getAllObjects(
        new Parse.Query('Collaboration')
          .equalTo('site', site));
    })
    
    .then(collabs => {
      let admins = [owner.id];
      let writers = [owner.id];
      let all = [owner.id];
      
      for (let collab of collabs) {
        let user = collab.get('user');
        let role = collab.get('role');
  
        modelACL.setReadAccess(user, true);
        modelACL.setWriteAccess(user, role == ROLE_ADMIN);
  
        if (role == ROLE_ADMIN)
          admins.push(user.id);
        if (role == ROLE_ADMIN || role == ROLE_EDITOR)
          writers.push(user.id);
        all.push(user.id);
      }
  
      model.setACL(modelACL);
      //!! uncontrolled async operation
      model.save();
      
      //set CLP for content table
      let CLP = {
        'get': {},
        'find': {},
        'create': {},
        'update': {},
        'delete': {},
        'addField': {},
        /*
        "readUserFields": [
          "owner"
        ],
        "writeUserFields": [
          "owner"
        ]
        */
      };
      
      for (let user of all) {
        CLP['get'][user] = true;
        CLP['find'][user] = true;
      }
      for (let user of writers) {
        CLP['create'][user] = true;
        CLP['update'][user] = true;
        CLP['delete'][user] = true;
      }
      for (let user of admins) {
        CLP['addField'][user] = true;
      }
  
      let data = {"classLevelPermissions": CLP};
      return setTableData(model.get('tableName'), data);
    })
    
    .then(() => response.success('ACL setup ends!'))
    
    .catch(e => response.error(e));
});


Parse.Cloud.define("sendEmail", function(request, response) {
  console.log("sendEmail " + new Date());
  
  let data = {
    from:     mailgunConfig.fromAddress,
    to:       request.params.address,
    subject:  request.params.subject,
    html:     request.params.body
  };
  
  mailgun.messages().send(data, error => {
    if (error) {
      console.log("got an error in sendEmail: " + error);
      response.error(error);
    }	else {
      console.log("email sent to " + toEmail + " " + new Date());
      response.success("Email sent!");
    }
  });
});