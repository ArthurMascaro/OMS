import { ApolloDriver, ApolloDriverConfig } from "@nestjs/apollo";
import { Module } from "@nestjs/common";
import { graphqlConfig } from "./graphql.config";
import { GraphQLModule } from "@nestjs/graphql";

@Module({
    imports: [
        GraphQLModule.forRoot<ApolloDriverConfig>({
            driver: ApolloDriver,
            ...graphqlConfig
        })
    ]
})
export class GraphqlModule {}