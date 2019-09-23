NODE_PATH=. node sago up --app=./tests --down | tee | sudo -u postgres psql
NODE_PATH=. ./node_modules/c8/bin/c8.js node ./tests
