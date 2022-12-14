const Router = require('express').Router();
const path = require('path');
const {promisify} = require('util');
const client = require('../service/redisDB');
const hmget = promisify(client.hmget).bind(client);
const passport = require('passport');
const passportConfig = require('../passport');
const model = require('../model');
const { Worker } = require('worker_threads');
/**===============================
 *  Extract info from vehicle name. blueprint of vehicle info
 */
class VehicleImageInterpreter {
    constructor(filename){
        this.name = path.parse(filename).name;
        this.ext = path.parse(filename).ext;
        const namePiece = this.name.split('_');
        this.station = namePiece[0];
        this.camera = namePiece[1];
        this.license = namePiece[2];
        this.date = namePiece[3];
        this.time = namePiece[4];
        this.color = namePiece[5];
        this.originColor = '';
        this.alert = 0;
        this.street = '';
        this.city = '';
        this.cityLabel='';
        this.model = '';
        this.renavamId = '';
        this.owner = '';
    }

    vehicleName(){
        return `${this.name}${this.ext}`
    }

    plateImgName(){
        return `${this.station}_${this.camera}_${this.license}_${this.date}_${this.time}${this.ext}`;
    }

    getDetectedTime(){
        let subString = this.date.split('-');
        let formattedDate = `${subString[1]}-${subString[0]}-${subString[2]}`;
        let formattedTime = this.time.replace(/-/g, ":");
        return new Date(formattedDate + ' ' + formattedTime);
    }

    toJson(){
        return {
            station: this.station,
            camera: this.camera,
            license: this.license,
            date: this.date,
            time: this.time,
            color: this.color,
            originColor: this.originColor,
            vehicleImg: this.vehicleName(),
            plateImg: this.plateImgName(),
            alert: this.alert,
            alertType: alertTypes[this.alert],
            city: this.city,
            street: this.street,
            model: this.model,
            renavam: this.renavamId,
            owner: this.owner,
            detectedAt: this.getDetectedTime()
        }
    }
}

class VehicleFromDocument {
    constructor(document){
        this.station = document.station;
        this.camera = document.camera;
        this.license = document.license;
        this.date = document.data;
        this.time = document.time;
        this.color = document.color;
        this.originColor = document.originColor;
        this.alert = document.alert;
        this.street = '';
        this.city = document.city;
        this.cityLabel='';
        this.model = document.model;
        this.renavamId = document.renavam;
        this.owner = document.owner;
        this.vehicleImg = document.vehicleImg;
        this.plateImg = document.plateImg;
    }

    toJson(){
        return {
            station: this.station,
            camera: this.camera,
            license: this.license,
            date: this.date,
            time: this.time,
            color: this.color,
            originColor: this.originColor,
            vehicleImg: this.vehicleImg,
            plateImg: this.plateImg,
            alert: this.alert,
            alertType: alertTypes[this.alert],
            city: this.city,
            street: this.street,
            model: this.model,
            renavam: this.renavamId,
            owner: this.owner
        }
    }
}

const groupsForAlert = [
    '5ff8c5a94ec2f1483053684d',
    '5ff8c5f24ec2f14830536851',
    '5ff8c6034ec2f14830536852',
    '5ff8c6114ec2f14830536853',
    '5ff8c61a4ec2f14830536854'
];

const alertTypes = [
    'Nenhum',
    'Roubo',
    'Licenciamento',
    'Renajud',
    'Envolvido na ocorr??ncia',
    'Investigado'
];

const rootPath = path.dirname(require.main.filename || process.mainModule.filename);

const thread = data =>{
    return new Promise((resolve, reject) =>{
        const worker = new Worker(`${rootPath}/service/worker.js`, {workerData:data});
        worker.on('message', resolve);
        worker.on('error', reject);
    });
};

const dateFormatter = (date, time) =>{
    let subString = date.split('-');
    let formattedDate = `${subString[1]}-${subString[0]}-${subString[2]}`;
    let formattedTime = time.replace(/-/g, ":");
    return new Date(formattedDate + ' ' + formattedTime);
};

/**===========================
 *  Handle new vehicle request from station
 */
Router.post('/add', async (req, res) =>{

    if (req.headers.authorization !== process.env.SERVER_TOKEN)
        return res.status(401)
            .send({
                success: false,
                errorMsg: "N??o autorizado"});

    let vehicle = new VehicleImageInterpreter(req.body.image);
    let renavamData = await hmget('renavam', vehicle.license);

    if(renavamData[0]){
        let renavamObj = JSON.parse(renavamData[0]);
        let modelId = renavamObj.makeAndModel;
        let modelData = await hmget('brand', modelId);
        if(modelData[0]){
            vehicle.model = modelData[0];
        }
        vehicle.renavamId = renavamObj.renavamId;
        vehicle.owner = renavamObj.owner;
        vehicle.originColor = renavamObj.color;
    }

    let station = await model.Station.findOne({id: vehicle.station});
    let camera = await model.Camera.findOne({cameraId: vehicle.camera, station: station._id});
    let city = await model.City.findById(camera.city);
    vehicle.street = camera.street;
    vehicle.city = camera.city;
    vehicle.cityLabel = `${city.city}-${city.state}`;

    let alerts = await hmget('alert', vehicle.license);
    let users = [];

    if(alerts[0]){
        vehicle.alert = parseInt(alerts[0]);

        let alert = await model.Alert.findOne({plate: vehicle.license, type: vehicle.alert, active: true});// Check if alert registered by users

        if (alert) {// if users registered alert, send sms, whatsapp, email to him
            let user = await model.User.findOne({_id: alert.createdBy}, {role: 0, password: 0, detectedAt: 0, updatedAt: 0});
            users.push(user);
            thread({vehicle: vehicle.toJson(), users: JSON.stringify(users)});
            model.Log.create({
                action: 'Alert',
                description: 'User logged in'
            }).then((res) =>{
                console.log(res)
            })
        }


        let groupMembers = await model.User.find({
            city: station.city,
            group: {$in: groupsForAlert}},
            {role: 0, password: 0, detectedAt: 0, updatedAt: 0});

        users = [...users, ...groupMembers];
    }

    model.Vehicle.create(vehicle.toJson(), (error, document) =>{
        if(error){
            return res.status(500).send({success: 0});
        }

        else {
            if(vehicle.alert !== 0){
                io.emit('vehicle', document);

                if(users.length > 0){
                    let notifications = [], socketTargets = [], logs = [];
                    for( let user of users){
                        notifications.push({
                            user: user._id,
                            vehicle: document._id,
                        });
                        logs.push({
                            action: 'Alert',
                            description: 'Alert triggered',
                            user: user._id
                        });
                        socketTargets.push(user._id);
                    }

                    model.Notification.insertMany(notifications, (error, docs) =>{
                        let results = {};
                        for(let doc of docs){
                            doc.vehicle = document;
                            results[doc.user] = doc;
                        }
                        io.emit('notification', {users: socketTargets, vehicles: results});
                    });
                    model.Log.insertMany(logs, (error, document) =>{
                        if(error) console.log(error);
                    })
                }

            }
            return res.status(201).send({success: 1});
        }
    });
});

Router.post('/fetchAll', passport.authenticate('jwt', {session: false}), async (req, res) =>{

    let count = await model.Vehicle.countDocuments(req.body.filterObj);

    model.Vehicle.find(req.body.filterObj)
        .sort(req.body.sort)
        .skip((req.body.page -1) * req.body.sizePerPage)
        .limit(req.body.sizePerPage)
        .exec((error, documents) =>{
            if(error){
                return res.status(500).send({
                    success: false,
                    errorMsg: "Algo deu errado"
                });
            }

            return res.status(200).send({success: true, vehicles: documents, total: count});
        })
});

Router.post('/alert', passport.authenticate('jwt', {session: false}), async (req, res) =>{

    let filter = {};
    if(req.body.filterObj.alert.length > 0)
        filter.alert = {$in: req.body.filterObj.alert};
    if(req.body.filterObj.range){
        let day = new Date();
        day.setDate(day.getDate() - req.body.filterObj.range);
        filter.detectedAt = {$gte: day}
    }

    let count = await model.Vehicle.countDocuments(filter);
    model.Vehicle.find(filter)
        .sort(req.body.sort)
        .skip((req.body.page -1) * req.body.sizePerPage)
        .limit(req.body.sizePerPage)
        .exec((error, documents) =>{
            if(error){
                return res.status(500).send({
                    success: false,
                    errorMsg: "Algo deu errado"
                });
            }

            return res.status(200).send({success: true, vehicles: documents, total: count});
        })
});

Router.get('/fetch/:id', passport.authenticate('jwt', {session: false}), async (req, res) =>{
    let vehicle = await model.Vehicle.findById({_id: req.params.id}, {_id: 0});
    if(vehicle){
        let station = await model.Station.findOne({id: vehicle.station})
            .populate({path: 'city'});
        let camera = await model.Camera.findOne({station: station._id, cameraId: vehicle.camera});
        return res.status(200).send({
            success: true,
            vehicle: vehicle,
            station: station,
            camera: camera
        })
    }else {
        return res.status(400).send({success: false, errorMsg: 'Relat??rio n??o existe'});
    }
});

Router.put('/update', passport.authenticate('jwt', {session: false}), async (req, res) =>{
    if(req.body.query.license){
        model.Vehicle.findById(req.body.id, {useFindAndModify: false}, async (error, document) =>{
            if(error){
                return res.status(500).send({
                    success: false,
                    errorMsg: "Algo deu errado"
                });
            }
            document.license = req.body.query.license;
            let renavamData = await hmget('renavam', req.body.query.license);
            if(renavamData[0]){
                let renavamObj = JSON.parse(renavamData[0]);
                let modelId = renavamObj.makeAndModel;
                let modelData = await hmget('brand', modelId);
                if(modelData[0]){
                    document.model = modelData[0];
                }
                document.renavamId = renavamObj.renavamId;
                document.owner = renavamObj.owner;
                document.originColor = renavamObj.color;
            }
            let alerts = await hmget('alert', req.body.query.license);
            let users = [];

            let station = await model.Station.findOne({id: document.station});
            let camera = await model.Camera.findOne({cameraId: document.camera, station: station._id});
            let city = await model.City.findById(camera.city);
            document.street = camera.street;
            document.city = camera.city;
            document.cityLabel = `${city.city}-${city.state}`;

            if(alerts[0]){
                vehicle.alert = parseInt(alerts[0]);

                let alert = await model.Alert.findOne({plate: vehicle.license, type: vehicle.alert, active: true});// Check if alert registered by users

                if (alert) {// if users registered alert, send sms, whatsapp, email to him
                    let user = await model.User.findOne({_id: alert.createdBy}, {role: 0, password: 0, detectedAt: 0, updatedAt: 0});
                    users.push(user);
                    thread({vehicle: vehicle.toJson(), users: JSON.stringify(users)});
                }


                let groupMembers = await model.User.find({
                        city: station.city,
                        group: {$in: groupsForAlert}},
                    {role: 0, password: 0, detectedAt: 0, updatedAt: 0});

                users = [...users, ...groupMembers];
            }
            else{
                document.alert = 0;
            }

            document.save((error, document) =>{
                if(error)
                    return res.status(500).send({success: 0});

                else {
                    if(document.alert !== 0){
                        io.emit('vehicle', document);

                        if(users.length > 0){
                            let notifications = [], socketTargets = [];
                            for( let user of users){
                                notifications.push({
                                    user: user._id,
                                    vehicle: document._id,
                                });
                                socketTargets.push(user._id);
                            }

                            model.Notification.insertMany(notifications, (error, docs) =>{
                                let results = {};
                                for(let doc of docs){
                                    doc.vehicle = document;
                                    results[doc.user] = doc;
                                }
                                io.emit('notification', {users: socketTargets, vehicles: results});
                            });
                        }

                    }
                    return res.status(201).send({success: 1});
                }
            });
        });
    }
    else
        model.Vehicle.findByIdAndUpdate(req.body.id, req.body.query,  {useFindAndModify: false},(err, docs) => {
            if (err){
                res.status(500).send({success:false, errorMsg: "Algo deu errado"});
            }
            else{
                res.status(202).send({success:true, docs: docs});
            }
    });
});

Router.get('/lastAlert/:station/:camera', passport.authenticate('jwt', {session: false}), (req, res) =>{
    model.Vehicle.find({station: req.params.station, camera: req.params.camera, alert: {$ne: 0}})
        .sort({detectedAt: 'desc'})
        .limit(1)
        .exec((error, documents) =>{
            if(error){
                return res.status(500).send({
                    success: false,
                    errorMsg: "Algo deu errado"
                });
            }

            return res.status(200).send({success: true, vehicles: documents});
        });
});

Router.post('/search', passport.authenticate('jwt', {session: false}), async (req, res) =>{
    let search = [];
    if(req.body.startDate && req.body.endDate){
        let start = new Date(req.body.startDate);
        let end = new Date(req.body.endDate);
        search.push({range:{path: 'detectedAt', gte: start, lte: end}});
    }
    if(req.body.color) search.push({text: {query: req.body.color, path: 'color'}});
    if(req.body.originColor) search.push({text: {query: req.body.originColor, path: 'originColor'}});
    if(req.body.camera) search.push({text: {query: req.body.camera, path: 'camera'}});
    if(req.body.city) search.push({text: {query: req.body.city, path: 'city'}});
    if(req.body.plate) search.push({wildcard:{query: req.body.plate.toUpperCase(), path: "license", allowAnalyzedField: true}});
    if(req.body.brand && req.body.model){
        search.push({
            wildcard: {
                query: `*${req.body.model.toUpperCase()}*${req.body.brand.toUpperCase()}*`,
                path: "model",
                allowAnalyzedField: true
            },
        });
    }else if(req.body.brand){
        search.push({
            wildcard: {
                query: `*${req.body.brand.toUpperCase()}*`,
                path: "model",
                allowAnalyzedField: true
            },
        });
    }else if(req.body.model){
        search.push({
            wildcard: {
                query: `*${req.body.model.toUpperCase()}*`,
                path: "model",
                allowAnalyzedField: true
            },
        });
    }

    let aggregate;
    if(search.length > 0) aggregate = model.Vehicle.aggregate().search({compound: {must: search}});
    else aggregate = model.Vehicle.aggregate();

    aggregate
        .sort({detectedAt: 'desc'})
        .skip((req.body.page -1) * req.body.sizePerPage)
        .limit(req.body.sizePerPage)
        .exec((error, documents)=>{
            model.Log.create({
                action: 'Search',
                user: req.user._id,
                description: 'User performed search'
            }).then((res) =>{
                console.log(res)
            });

            if(error){
                return res.status(500).send({
                    success: false,
                    errorMsg: "Algo deu errado"
                });
            }

            return res.status(200).send({success: true, vehicles: documents, total: 2});
    });
});

Router.post('/companion', passport.authenticate('jwt', {session: false}), async (req, res) =>{
    let search = [];
    if(req.body.plate)
        search.push({
            text:{
                query: req.body.plate.toUpperCase(),
                path: "license"
            }
        });

    let aggregate;
    if(search.length > 0) aggregate = model.Vehicle.aggregate().search({compound: {must: search}});
    else aggregate = model.Vehicle.aggregate();

    aggregate
        .sort({detectedAt: 'desc'})
        .exec(async (error, documents)=>{
            if(error){
                return res.status(500).send({
                    success: false,
                    errorMsg: "Algo deu errado"
                });
            }

            let filtered = [];
            let target;

            let startTime;

            for(let document of documents){
                if(!startTime){
                    target = document;
                    startTime = new Date(document.detectedAt || document.createdAt);
                    let start =new Date(document.detectedAt || document.createdAt);
                    let end = new Date(document.detectedAt || document.createdAt);
                    start.setMinutes(start.getMinutes() - 1);
                    end.setMinutes(end.getMinutes() + 1);
                    let vehicles = await model.Vehicle.find({
                        camera: document.camera,
                        detectedAt: {$gte: start, $lte: end},
                        license: {$ne: document.license}});
                    Array.prototype.push.apply(filtered, vehicles);
                }else{
                    let differ;
                    document.detectedAt?
                    differ = Math.abs(document.detectedAt - startTime)
                    :differ = Math.abs(document.createdAt - startTime);
                    if(differ > 300000){
                        startTime = new Date(document.detectedAt || document.createdAt);
                        let start =new Date(document.detectedAt || document.createdAt);
                        let end = new Date(document.detectedAt || document.createdAt);
                        start.setMinutes(start.getMinutes() - 1);
                        end.setMinutes(end.getMinutes() + 1);
                        let vehicles = await model.Vehicle.find({
                            camera: document.camera,
                            detectedAt: {$gte: start, $lte: end},
                            license: {$ne: document.license}});
                        Array.prototype.push.apply(filtered, vehicles);
                    }
                }
            }

            const lookup = filtered.reduce((a, e) => {
                a[e.license] = ++a[e.license] || 0;
                return a;
            }, {});

            let duplicates = filtered.filter(e => lookup[e.license]);

            return res.status(200).send({
                success: true,
                vehicles: duplicates,
                target: target,
                total: duplicates.length
            });
        });
});

module.exports = Router;