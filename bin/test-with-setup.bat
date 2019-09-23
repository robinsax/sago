set NODE_PATH=.
node sago up --app=./tests --full --down | psql --username=postgres
npx c8 node ./tests