import * as React from 'react';
import { useState } from 'react';
import gql from 'graphql-tag';
import { LOCAL_SERVER_URL, standaloneProperties } from '../config';
import { IStoreContainer } from '../interfaces/store';
import { FormControl, Select, MenuItem, LinearProgress } from '@material-ui/core';
import { observer } from 'mobx-react';
import DonwloadSnapshotButton from '../components/DownloadSnapshotButton';
import { useDecreyptedPrivateKeyQuery, useProtectedPrivateKeysQuery, KeyStoreType, ProtectedPrivateKeysQuery } from '../generated/graphql';

type ILoginComponentProps = IStoreContainer & ProtectedPrivateKeysQuery

const LoginView = observer((props: IStoreContainer) => {
    const { loading, error, data } = useProtectedPrivateKeysQuery();
    error != undefined ? console.log(error) : null

    return (
        <div>
            <div className="login">
                <div className="container">
                    <div className="header">
                        <h3>Login</h3>
                    </div>
                    {
                        loading || undefined === data || error != undefined ?
                            <WaitComponent
                                error={error}
                                loading={loading}
                            /> :
                            <LoginComponent
                                {...props}
                                keyStore={data.keyStore}
                            />
                    }
                </div>
            </div>
        </div>
    );
});

function WaitComponent(props: any) {
    const errorHandler = (error: any) => {
        console.log(error);
        return (
            <label>An Error Accupied.</label>
        )
    }
    return (
        <div>
            {
                props.error != undefined ?
                    <label>{errorHandler(props.error)}</label> :
                    <label>Now Loading...</label>
            }
            <label></label>
        </div>
    )
}

const LoginComponent = observer((props: ILoginComponentProps) => {
    const [ passphrase, setPassphrase ] = useState('');
    const { accountStore, routerStore, keyStore } = props
    const { data } = useDecreyptedPrivateKeyQuery({
        variables: {
            address: accountStore.selectAddress,
            passphrase: passphrase
        },
    });

    const addresses = keyStore?.protectedPrivateKeys?.map((value) => value?.address)
    addresses?.map((value) => {
        accountStore.addresses.includes(value) ? null : accountStore.addAddress(value);
    })

    const handleAccount = () => {
        accountStore.setPrivateKey(data?.keyStore?.decryptedPrivateKey);
        accountStore.toggleLogin();
        const properties = {
            ...standaloneProperties,
            PrivateKeyString: data?.keyStore?.decryptedPrivateKey
        }
        console.log(properties);
        fetch(`http://${LOCAL_SERVER_URL}/run-standalone`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(properties)
        })
        .then(response => response.text())
        .then(body => console.log(body));
    }

    const handleChange = (event: React.ChangeEvent<{ value: unknown }>) => {
        accountStore.setSelectedAddress(event.target.value as string)
    };

    // FIXME 키가 하나도 없을때 처리는 안해도 되지 않을지?
    if (!accountStore.selectAddress && accountStore.addresses.length > 0)
    {
        accountStore.setSelectedAddress(accountStore.addresses[0]);
    }

    return (
        <div>
            <form>
                <FormControl>
                    <Select
                        id="account-select"
                        value={accountStore.selectAddress}
                        onChange={handleChange}
                        autoWidth
                    >
                        {
                            accountStore.addresses.map((value) => <MenuItem key={value} value={value}>{value}</MenuItem>)
                        }
                    </Select>
                </FormControl>
                <br />
                <label>Passphrase</label> <input type="password" onChange={event => { setPassphrase(event.target.value); }}></input>
            </form>
            <button disabled={data == undefined} onClick={event => { handleAccount() }}>Login </button>
            <br />
            <button onClick={() => routerStore.push('/account')} > Account Management </button>
            <br />
            <button onClick={() => routerStore.push('/config')} > Config </button>
        </div>
    )
});

export default LoginView
