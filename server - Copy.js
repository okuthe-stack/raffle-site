require("dotenv").config();

const express = require("express");
const cors = require("cors");
const sqlite3 = require("sqlite3").verbose();
const multer = require("multer");
const path = require("path");
const axios = require("axios");

const app = express();

app.use(cors());
app.use(express.json());
app.use("/uploads", express.static("uploads"));

const db = new sqlite3.Database("./raffle.db");

db.run(`
CREATE TABLE IF NOT EXISTS winners (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticketNumber INTEGER,
    name TEXT,
    productId INTEGER,
    drawDate TEXT
)
`);

// IMAGE UPLOAD
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, "uploads/");
    },

    filename: (req, file, cb) => {
        cb(null, Date.now() + path.extname(file.originalname));
    }
});

const upload = multer({ storage });


// DATABASE SETUP

db.serialize(() => {

    db.run(`
        CREATE TABLE IF NOT EXISTS products (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT,
            description TEXT,
            image TEXT,
            price REAL,
            totalTickets INTEGER
        )
    `);


    db.run(`
        CREATE TABLE IF NOT EXISTS tickets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT,
            phone TEXT,
            ticketNumber INTEGER,
            productId INTEGER
        )
    `);


    db.run(`
        CREATE TABLE IF NOT EXISTS payments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            phone TEXT,
            amount REAL,
            productId INTEGER,
            quantity INTEGER,
            checkoutRequestID TEXT,
            status TEXT
        )
    `);


    db.get("SELECT COUNT(*) AS count FROM products", (err, row)=>{

        if(row && row.count === 0){

            db.run(`
            INSERT INTO products
            (name,description,image,price,totalTickets)

            VALUES

            ('iPhone 13',
            'Premium smartphone prize',
            '',
            100,
            1800),

            ('Gaming Laptop',
            'High performance gaming machine',
            '',
            100,
            2200),

            ('AirPods Pro',
            'Wireless premium headphones',
            '',
            100,
            150)

            `);

        }

    });

});


// GET PRODUCTS

app.get("/products",(req,res)=>{

    db.all(
        "SELECT * FROM products",
        (err,products)=>{

            let completed = 0;
            let result = [];

            if(products.length === 0){
                return res.json([]);
            }


            products.forEach(product=>{


                db.get(
                    "SELECT COUNT(*) AS sold FROM tickets WHERE productId=?",
                    [product.id],
                    (err,row)=>{


                        result.push({

                            ...product,

                            soldTickets: row ? row.sold : 0

                        });


                        completed++;


                        if(completed === products.length){

                            res.json(result);

                        }

                    }
                );


            });


        }
    );


});


// GET ACCESS TOKEN

async function getAccessToken(){


    const consumerKey = process.env.CONSUMER_KEY;

    const consumerSecret = process.env.CONSUMER_SECRET;


    const auth = Buffer
        .from(
            consumerKey + ":" + consumerSecret
        )
        .toString("base64");



    const response = await axios.get(

        "https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials",

        {

            headers:{

                Authorization:"Basic " + auth

            }

        }

    );


    return response.data.access_token;


}

// START MPESA PAYMENT

app.post("/mpesa/stkpush", async (req,res)=>{

    try {

        const {
            phone,
            productId,
            quantity
        } = req.body;


        db.get(
            "SELECT * FROM products WHERE id=?",
            [productId],
            async (err,product)=>{


                if(!product){

                    return res.json({
                        message:"Product not found"
                    });

                }


                const amount = product.price * quantity;


                const accessToken = await getAccessToken();


                const timestamp = new Date()
                .toISOString()
                .replace(/[-T:.Z]/g,"")
                .slice(0,14);



                const password = Buffer
                .from(
                    process.env.SHORTCODE +
                    process.env.PASSKEY +
                    timestamp
                )
                .toString("base64");



                const response = await axios.post(

                    "https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest",

                    {

                        BusinessShortCode:
                        process.env.SHORTCODE,


                        Password:
                        password,


                        Timestamp:
                        timestamp,


                        TransactionType:
                        "CustomerPayBillOnline",


                        Amount:
                        amount,


                        PartyA:
                        phone,


                        PartyB:
                        process.env.SHORTCODE,


                        PhoneNumber:
                        phone,


                        CallBackURL:
                        process.env.CALLBACK_URL,


                        AccountReference:
                        product.name,


                        TransactionDesc:
                        "Raffle Ticket Purchase"


                    },


                    {

                        headers:{

                            Authorization:
                            "Bearer " + accessToken

                        }

                    }

                );


                db.run(

                    `INSERT INTO payments
                    (phone,amount,productId,quantity,checkoutRequestID,status)

                    VALUES (?,?,?,?,?,?)`,

                    [

                        phone,
                        amount,
                        productId,
                        quantity,
                        response.data.CheckoutRequestID,
                        "pending"

                    ]

                );


                res.json(response.data);


            }
        );


    }

    catch(error){

        console.log(error.response?.data || error.message);

        res.json({

            message:"Payment failed"

        });

    }


});




// MPESA CALLBACK

app.post("/mpesa/callback",(req,res)=>{

    console.log(
        "MPESA CALLBACK",
        JSON.stringify(req.body,null,2)
    );


    const callback = req.body.Body.stkCallback;


    const checkoutRequestID = callback.CheckoutRequestID;


    const resultCode = callback.ResultCode;



    if(resultCode === 0){


        db.get(

            "SELECT * FROM payments WHERE checkoutRequestID=?",

            [checkoutRequestID],

            (err,payment)=>{


                if(payment){


                    db.run(

                        "UPDATE payments SET status=? WHERE id=?",

                        [
                            "completed",
                            payment.id
                        ]

                    );



                    for(
                        let i = 0;
                        i < payment.quantity;
                        i++
                    ){


                        const ticketNumber =
                        Math.floor(
                            100000 +
                            Math.random() * 900000
                        );


                        db.run(

                            `INSERT INTO tickets
                            (name,ticketNumber,productId)

                            VALUES (?,?,?)`,

                            [
                                payment.phone,
                                ticketNumber,
                                payment.productId
                            ]

                        );


                    }


                }


            }

        );


    }



    res.json({

        ResultCode:0,

        ResultDesc:"Accepted"

    });


});




// UPLOAD IMAGE

app.post("/upload/:id",
upload.single("image"),
(req,res)=>{


    const image =
    "/uploads/" + req.file.filename;


    db.run(

        "UPDATE products SET image=? WHERE id=?",

        [
            image,
            req.params.id
        ]

    );


    res.json({

        image:image

    });


});




// CREATE PRODUCT

app.post("/create-product",(req,res)=>{


    const {
        name,
        description,
        price,
        totalTickets
    } = req.body;



    db.run(

        `INSERT INTO products
        (name,description,image,price,totalTickets)

        VALUES (?,?,?,?,?)`,

        [
            name,
            description,
            "",
            price,
            totalTickets
        ],

        function(){

            res.json({
                id:this.lastID
            });

        }

    );


});




// UPDATE PRODUCT

app.post("/update-product",(req,res)=>{


    const {
        id,
        price,
        totalTickets
    } = req.body;



    db.run(

        "UPDATE products SET price=?, totalTickets=? WHERE id=?",

        [
            price,
            totalTickets,
            id
        ],

        ()=>{

            res.json({
                message:"Updated"
            });

        }

    );


});




// DELETE PRODUCT

app.delete("/delete-product/:id",(req,res)=>{


    db.run(

        "DELETE FROM products WHERE id=?",

        [
            req.params.id
        ],

        ()=>{

            res.json({
                message:"Deleted"
            });

        }

    );


});




// SERVER

app.get("/payments",(req,res)=>{

    db.all(
        "SELECT * FROM payments",
        (err,rows)=>{

            if(err){
                return res.json(err);
            }

            res.json(rows);

        }
    );

});

app.get("/tickets",(req,res)=>{

    db.all(
        "SELECT * FROM tickets",
        (err,rows)=>{

            if(err){
                return res.json(err);
            }

            res.json(rows);

        }
    );

});

// UPDATE PRODUCT

app.put("/products/:id",(req,res)=>{

    const id = req.params.id;

    const {
        name,
        description,
        price,
        totalTickets
    } = req.body;


    db.run(
        `
        UPDATE products
        SET name=?,
        description=?,
        price=?,
        totalTickets=?
        WHERE id=?
        `,
        [
            name,
            description,
            price,
            totalTickets,
            id
        ],
        function(err){

            if(err){
                return res.json({error:err.message});
            }

            res.json({
                message:"Product updated"
            });

        }
    );

});




// DELETE PRODUCT

app.delete("/products/:id",(req,res)=>{

    const id=req.params.id;


    db.run(
        "DELETE FROM products WHERE id=?",
        [id],
        function(err){

            if(err){
                return res.json({error:err.message});
            }


            res.json({
                message:"Product deleted"
            });

        }
    );

});

// GET PAYMENTS FOR ADMIN

app.get("/payments",(req,res)=>{

    db.all(
        "SELECT * FROM payments ORDER BY id DESC",
        (err,rows)=>{

            if(err){
                return res.json({
                    error:err.message
                });
            }

            res.json(rows);

        }
    );

});

// GET TICKETS FOR ADMIN

app.get("/tickets",(req,res)=>{

    db.all(
        "SELECT * FROM tickets ORDER BY id DESC",
        (err,rows)=>{

            if(err){
                return res.json({
                    error:err.message
                });
            }

            res.json(rows);

        }
    );

});

app.get("/check-tables",(req,res)=>{

    db.all(
        "SELECT name FROM sqlite_master WHERE type='table'",
        (err,rows)=>{

            if(err){
                return res.json({error:err.message});
            }

            res.json(rows);

        }
    );

});


// DRAW WINNER

app.post("/draw-winner",(req,res)=>{


db.get(
"SELECT * FROM tickets ORDER BY RANDOM() LIMIT 1",

(err,ticket)=>{


if(err){
return res.json({
error:err.message
});
}


if(!ticket){

return res.json({
message:"No tickets available"
});

}


const date = new Date().toISOString();


db.run(

`
INSERT INTO winners
(ticketNumber,name,productId,drawDate)

VALUES(?,?,?,?)
`,

[
ticket.ticketNumber,
ticket.name,
ticket.productId,
date
],

function(err){

if(err){

return res.json({
error:err.message
});

}


res.json({

message:"Winner selected",

winner:ticket

});


}

);


}

);


});


// GET WINNER HISTORY

app.get("/winners",(req,res)=>{


db.all(

"SELECT * FROM winners ORDER BY id DESC",

(err,rows)=>{


if(err){

return res.json({
error:err.message
});

}


res.json(rows);


}

);


});

// DELETE TEST WINNER

app.get("/delete-test-winner",(req,res)=>{


db.run(
"DELETE FROM winners WHERE name='thompson'",
function(err){


if(err){
return res.json({
error:err.message
});
}


res.json({
message:"Test winner deleted",
deleted:this.changes
});


});


});



// DELETE TEST TICKET

app.get("/delete-test-ticket",(req,res)=>{


db.run(
"DELETE FROM tickets WHERE productId=3",
function(err){


if(err){
return res.json({
error:err.message
});
}


res.json({
message:"Test ticket deleted",
deleted:this.changes
});


});


});


// UPDATE PRODUCT PRICE

app.put("/products/:id/price",(req,res)=>{


const id = req.params.id;

const price = req.body.price;



db.run(

"UPDATE products SET price=? WHERE id=?",

[
price,
id
],

function(err){


if(err){

return res.json({
error:err.message
});

}


res.json({

message:"Price updated successfully",

id:id,

price:price

});


}


);


});


app.listen(3000,()=>{

    console.log(
        "Server running on port 3000"
    );

});