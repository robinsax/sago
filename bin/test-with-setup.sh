NODE_PATH=. node sago up --app=./tests --down | sudo -u postgres psql
c8 node ./tests
